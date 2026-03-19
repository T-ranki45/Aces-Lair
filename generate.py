import os
import sys

import torch

from model import AcesGPT
from tokenizer import BpeTokenizer

# --- Configuration ---
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
CHECKPOINT_FILE = "aces_weights.pth"
LATEST_CHECKPOINT_FILE = "aces_weights_latest.pth"
BEST_CHECKPOINT_FILE = "aces_weights_best.pth"
DATA_FILE = "data.txt"
TOKENIZER_FILE = "aces_tokenizer.model"


def find_inference_checkpoint():
    for candidate in (BEST_CHECKPOINT_FILE, LATEST_CHECKPOINT_FILE, CHECKPOINT_FILE):
        if os.path.exists(candidate):
            return candidate
    return None

def main():
    # --- 1. Load Tokenizer ---
    # Load the pre-trained tokenizer state from the file created by train.py
    tokenizer = BpeTokenizer()
    try:
        tokenizer.load(TOKENIZER_FILE)
    except FileNotFoundError:
        print(f"ERROR: Tokenizer file '{TOKENIZER_FILE}' not found. Please run train.py first to create it.", file=sys.stderr)
        sys.exit(1)

    # --- 2. Load Model from Checkpoint ---
    checkpoint_path = find_inference_checkpoint()
    try:
        if checkpoint_path is None:
            raise FileNotFoundError
        checkpoint = torch.load(checkpoint_path, map_location=DEVICE)
    except FileNotFoundError:
        print(
            f"ERROR: No model checkpoint found ({CHECKPOINT_FILE}, "
            f"{LATEST_CHECKPOINT_FILE}, or {BEST_CHECKPOINT_FILE}). "
            "Please run train.py first.",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"[A.C.E.S] Using checkpoint: {checkpoint_path}", file=sys.stderr)

    # Get model config from checkpoint, with fallbacks for older checkpoints
    config = checkpoint.get('config', {
        'vocab_size': 5000, 'd_model': 384, 'num_heads': 6, 'num_layers': 6,
        'd_ff': 384 * 4, 'block_size': 128, 'dropout': 0.2
    })
    # Ensure vocab size in config matches the actual loaded tokenizer
    config['vocab_size'] = len(tokenizer.vocab)

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

    # Load the trained weights
    model.load_state_dict(checkpoint['model_state_dict'])

    model.eval() # Set model to evaluation mode

    # --- 3. Get Prompt from Command Line ---
    # The first command-line argument will be the user's message
    prompt = sys.argv[1] if len(sys.argv) > 1 else "A.c.e.s AI is"

    # --- 4. Generate Text ---
    start_ids = tokenizer.encode(prompt)
    x = (torch.tensor(start_ids, dtype=torch.long, device=DEVICE)[None, ...])

    with torch.no_grad():
        y = model.generate(x, max_new_tokens=150) # Generate up to 150 new tokens
        output_text = tokenizer.decode(y[0].tolist())
        
        # Print the final output to stdout so Node.js can capture it
        print(output_text)

if __name__ == "__main__":
    main()
