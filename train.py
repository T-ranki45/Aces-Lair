import math
import os
import time
import torch
import torch.nn as nn
from torch.optim import AdamW

# Import our custom model and tokenizer
from model import AcesGPT
from tokenizer import BpeTokenizer

# --- 1. Hyperparameters & Configuration ---
# Training settings
BATCH_SIZE = 32
BLOCK_SIZE = 128  # Max sequence length for the model
MAX_ITERS = 4000
EVAL_INTERVAL = 100
LEARNING_RATE = 3e-4
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
EVAL_ITERS = 40
LOG_INTERVAL = 20
CHECKPOINT_INTERVAL = 1000
CHECKPOINT_FILE = "aces_weights.pth"
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
if os.path.exists(CHECKPOINT_FILE):
    print(f"Resuming training from checkpoint: {CHECKPOINT_FILE}")
    checkpoint = torch.load(CHECKPOINT_FILE, map_location=DEVICE)
    # Note: It's good practice to check if checkpoint config matches current config
    model.load_state_dict(checkpoint['model_state_dict'])
    optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
    start_iter = checkpoint['iter_num'] + 1
    best_val_loss = checkpoint.get('best_val_loss', float('inf')) # Use .get for backward compatibility
    print(f"Resumed from iteration {start_iter} with best validation loss {best_val_loss:.4f}")


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
for iter in range(start_iter, MAX_ITERS):
    iter_start = time.time()
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
            # Optionally save a separate 'best' model
            # torch.save(model.state_dict(), 'aces_best_weights.pth')

    if iter > 0 and iter % CHECKPOINT_INTERVAL == 0:
        print(f"Saving checkpoint to {CHECKPOINT_FILE}...")
        checkpoint = {
            'model_state_dict': model.state_dict(),
            'optimizer_state_dict': optimizer.state_dict(),
            'iter_num': iter,
            'best_val_loss': best_val_loss,
            'config': config,
        }
        torch.save(checkpoint, CHECKPOINT_FILE)

    xb, yb = get_batch('train')
    logits = model(xb)
    B, T, C = logits.shape
    loss = loss_fn(logits.view(B*T, C), yb.view(B*T))
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    optimizer.step()

    if (iter + 1) % LOG_INTERVAL == 0:
        elapsed = time.time() - iter_start
        print(
            f"Iter {iter+1}/{MAX_ITERS} | loss {loss.item():.4f} | "
            f"iter time {elapsed:.2f}s",
        )

print("--- Training finished ---")

print(f"Saving final checkpoint to {CHECKPOINT_FILE}")
final_checkpoint = {
    'model_state_dict': model.state_dict(),
    'optimizer_state_dict': optimizer.state_dict(),
    'iter_num': MAX_ITERS - 1,
    'best_val_loss': best_val_loss,
    'config': config,
}
torch.save(final_checkpoint, CHECKPOINT_FILE)
