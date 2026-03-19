import argparse
import json
import math
import os
import time
from datetime import datetime, timezone

import torch
import torch.nn as nn
from torch.optim import AdamW

# Import our custom model and tokenizer
from model import AcesGPT
from tokenizer import BpeTokenizer

# --- 1. Hyperparameters & Configuration ---
def parse_args():
    parser = argparse.ArgumentParser(
        description="Train the A.C.E.S. language model with checkpoint resume support.",
    )
    parser.add_argument("--max-iters", type=int, default=4000)
    parser.add_argument("--eval-interval", type=int, default=100)
    parser.add_argument("--log-interval", type=int, default=20)
    parser.add_argument("--checkpoint-interval", type=int, default=25)
    parser.add_argument("--eval-iters", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--block-size", type=int, default=128)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument(
        "--resume-from",
        default=None,
        help="Resume from a specific checkpoint file instead of auto-discovery.",
    )
    parser.add_argument(
        "--no-resume",
        action="store_true",
        help="Start from scratch even if checkpoint files exist.",
    )
    return parser.parse_args()


args = parse_args()

# Training settings
BATCH_SIZE = args.batch_size
BLOCK_SIZE = args.block_size  # Max sequence length for the model
MAX_ITERS = args.max_iters
EVAL_INTERVAL = args.eval_interval
LEARNING_RATE = args.learning_rate
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
EVAL_ITERS = args.eval_iters
LOG_INTERVAL = args.log_interval
CHECKPOINT_INTERVAL = args.checkpoint_interval
CHECKPOINT_FILE = "aces_weights.pth"
LATEST_CHECKPOINT_FILE = "aces_weights_latest.pth"
BEST_CHECKPOINT_FILE = "aces_weights_best.pth"
STATE_FILE = "aces_training_state.json"
DATA_FILE = "data.txt"
TOKENIZER_FILE = "aces_tokenizer.model"

# Group hyperparameters into a config dict for saving
config = {
    'vocab_size': 5000,
    'd_model': 384,
    'num_heads': 6,
    'num_layers': 6,
    'd_ff': 384 * 4,
    'block_size': BLOCK_SIZE,
    'dropout': 0.2,
}

def atomic_torch_save(payload, destination):
    """Write checkpoints atomically so sudden shutdowns don't corrupt the file."""
    temp_path = f"{destination}.tmp"
    torch.save(payload, temp_path)
    os.replace(temp_path, destination)


def build_checkpoint(iter_num, best_val_loss):
    return {
        'model_state_dict': model.state_dict(),
        'optimizer_state_dict': optimizer.state_dict(),
        'iter_num': iter_num,
        'best_val_loss': best_val_loss,
        'config': config,
    }


def save_checkpoint_files(iter_num, best_val_loss, save_best=False):
    checkpoint = build_checkpoint(iter_num, best_val_loss)
    atomic_torch_save(checkpoint, LATEST_CHECKPOINT_FILE)
    if save_best:
        atomic_torch_save(checkpoint, BEST_CHECKPOINT_FILE)


def write_training_state(iter_num, best_val_loss, status, checkpoint_path=None):
    payload = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "iter_num": iter_num,
        "best_val_loss": None if best_val_loss == float("inf") else best_val_loss,
        "device": DEVICE,
        "checkpoint_path": checkpoint_path,
        "max_iters": MAX_ITERS,
        "eval_interval": EVAL_INTERVAL,
        "checkpoint_interval": CHECKPOINT_INTERVAL,
        "data_file": DATA_FILE,
        "tokenizer_file": TOKENIZER_FILE,
    }
    with open(STATE_FILE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def find_resume_checkpoint():
    if args.resume_from:
        return args.resume_from if os.path.exists(args.resume_from) else None
    for candidate in (LATEST_CHECKPOINT_FILE, CHECKPOINT_FILE, BEST_CHECKPOINT_FILE):
        if os.path.exists(candidate):
            return candidate
    return None


resume_checkpoint = None if args.no_resume else find_resume_checkpoint()
checkpoint = None

if resume_checkpoint:
    print(f"Found resume checkpoint: {resume_checkpoint}")
    checkpoint = torch.load(resume_checkpoint, map_location=DEVICE)
    checkpoint_config = checkpoint.get("config", {})
    if checkpoint_config:
        config.update(checkpoint_config)
        BLOCK_SIZE = config["block_size"]
else:
    print("No checkpoint found. Starting a fresh training run.")

# --- 2. Data Loading & Tokenization ---
print("--- Loading data and training tokenizer ---")

# Create a placeholder data.txt if it doesn't exist
try:
    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        text = f.read()
    if not text:
        raise FileNotFoundError
except FileNotFoundError:
    print(f"'{DATA_FILE}' not found or is empty. Creating a placeholder.")
    text = """
A.c.e.s AI is an advanced, highly capable, and helpful AI assistant.
This is a sample text file for training the model. The more data you add here,
the smarter the model will become. You can add books, articles, or code.
The training process involves reading this text, tokenizing it, and learning
to predict the next token in a sequence.
"""
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        f.write(text)

# Initialize and train the tokenizer
tokenizer = BpeTokenizer()
tokenizer.train(text, config['vocab_size'])
tokenizer.save("aces_tokenizer")  # This will create aces_tokenizer.model
print(f"Tokenizer trained with vocab size: {len(tokenizer.vocab)}")
print(f"Tokenizer state saved to {TOKENIZER_FILE}")

# Encode the entire dataset and create tensors
encoded_ids = tokenizer.encode(text)

# Ensure dataset is large enough for the model's context window (BLOCK_SIZE)
target_tokens = (BLOCK_SIZE + 1) * 12
if len(encoded_ids) < target_tokens:
    print(f"Note: Dataset is small ({len(encoded_ids)} tokens). Repeating text to meet minimum size requirements.")
    repeats = math.ceil(target_tokens / len(encoded_ids))
    encoded_ids = (encoded_ids * repeats)[:target_tokens]

print(f"Training tokens after padding: {len(encoded_ids)}")

data = torch.tensor(encoded_ids, dtype=torch.long)

# Split data into training and validation sets
n = int(0.9 * len(data))
train_data = data[:n]
val_data = data[n:]

def get_batch(split):
    """Generate a small batch of data of inputs x and targets y."""
    data = train_data if split == 'train' else val_data
    # Generate random starting points for our batches
    ix = torch.randint(len(data) - BLOCK_SIZE, (BATCH_SIZE,))
    # Stack the sequences for each starting point
    x = torch.stack([data[i:i+BLOCK_SIZE] for i in ix])
    # The target is the input sequence shifted by one
    y = torch.stack([data[i+1:i+BLOCK_SIZE+1] for i in ix])
    return x.to(DEVICE), y.to(DEVICE)

# --- 3. Model, Optimizer, and Loss Function ---
print(f"--- Initializing model on {DEVICE} ---")

model = AcesGPT(
    vocab_size=config['vocab_size'],
    d_model=config['d_model'],
    num_heads=config['num_heads'],
    num_layers=config['num_layers'],
    d_ff=config['d_ff'],
    max_seq_len=config['block_size'],
    dropout=config['dropout']
)
model.to(DEVICE)

# Define the loss function (standard for language modeling)
loss_fn = nn.CrossEntropyLoss()

# Define the optimizer
optimizer = AdamW(model.parameters(), lr=LEARNING_RATE)

# --- Check for checkpoint to resume training ---
start_iter = 0
best_val_loss = float('inf')
if checkpoint is not None:
    print(f"Resuming training from checkpoint: {resume_checkpoint}")
    model.load_state_dict(checkpoint['model_state_dict'])
    optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
    start_iter = checkpoint['iter_num'] + 1
    best_val_loss = checkpoint.get('best_val_loss', float('inf'))  # Backward compatibility
    print(f"Resumed from iteration {start_iter} with best validation loss {best_val_loss:.4f}")
    write_training_state(start_iter - 1, best_val_loss, "resumed", resume_checkpoint)
else:
    write_training_state(-1, best_val_loss, "fresh_start")


# --- 4. Training & Evaluation Loop ---

@torch.no_grad()
def estimate_loss():
    """Helper function to estimate loss on train and val sets."""
    out = {}
    model.eval() # Set model to evaluation mode
    for split in ['train', 'val']:
        losses = torch.zeros(EVAL_ITERS)
        for k in range(EVAL_ITERS):
            X, Y = get_batch(split)
            logits = model(X)
            B, T, C = logits.shape
            loss = loss_fn(logits.view(B*T, C), Y.view(B*T))
            losses[k] = loss.item()
        out[split] = losses.mean()
    model.train() # Set model back to training mode
    return out

print("--- Starting training loop ---")
last_completed_iter = start_iter - 1

try:
    for iter in range(start_iter, MAX_ITERS):
        iter_start = time.time()
        should_save_best = False
        if iter % EVAL_INTERVAL == 0 or iter == MAX_ITERS - 1:
            eval_start = time.time()
            losses = estimate_loss()
            eval_duration = time.time() - eval_start
            print(
                f"Step {iter}: train loss {losses['train']:.4f}, "
                f"val loss {losses['val']:.4f} (eval {eval_duration:.1f}s)",
            )
            if losses['val'] < best_val_loss:
                best_val_loss = losses['val']
                should_save_best = True
                print(
                    f"New best validation loss {best_val_loss:.4f}. "
                    f"Saving best checkpoint to {BEST_CHECKPOINT_FILE}.",
                )

            save_checkpoint_files(iter, best_val_loss, save_best=should_save_best)
            write_training_state(
                iter,
                best_val_loss,
                "checkpoint_saved",
                LATEST_CHECKPOINT_FILE,
            )

        if (
            iter > 0
            and iter % CHECKPOINT_INTERVAL == 0
            and iter % EVAL_INTERVAL != 0
        ):
            print(f"Saving rolling checkpoint to {LATEST_CHECKPOINT_FILE}...")
            save_checkpoint_files(iter, best_val_loss)
            write_training_state(
                iter,
                best_val_loss,
                "rolling_checkpoint",
                LATEST_CHECKPOINT_FILE,
            )

        xb, yb = get_batch('train')
        logits = model(xb)
        B, T, C = logits.shape
        loss = loss_fn(logits.view(B*T, C), yb.view(B*T))
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        last_completed_iter = iter

        if (iter + 1) % LOG_INTERVAL == 0:
            elapsed = time.time() - iter_start
            print(
                f"Iter {iter+1}/{MAX_ITERS} | loss {loss.item():.4f} | "
                f"iter time {elapsed:.2f}s",
            )

except KeyboardInterrupt:
    print("\nTraining interrupted. Saving latest checkpoint before exit...")
    if last_completed_iter >= 0:
        save_checkpoint_files(last_completed_iter, best_val_loss)
        write_training_state(
            last_completed_iter,
            best_val_loss,
            "interrupted",
            LATEST_CHECKPOINT_FILE,
        )
    raise SystemExit(130)

print("--- Training finished ---")

print(f"Saving final checkpoint to {CHECKPOINT_FILE}")
final_checkpoint = build_checkpoint(MAX_ITERS - 1, best_val_loss)
atomic_torch_save(final_checkpoint, CHECKPOINT_FILE)
atomic_torch_save(final_checkpoint, LATEST_CHECKPOINT_FILE)
write_training_state(MAX_ITERS - 1, best_val_loss, "finished", CHECKPOINT_FILE)
