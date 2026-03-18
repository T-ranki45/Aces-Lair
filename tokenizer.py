import re
import json

# Helper function to get all unique consecutive pairs in a list of ids
def get_stats(ids):
    """
    Given a list of integers, return a dictionary of counts of consecutive pairs.
    Example: [1, 2, 3, 1, 2] -> {(1, 2): 2, (2, 3): 1}
    """
    counts = {}
    for pair in zip(ids, ids[1:]):
        counts[pair] = counts.get(pair, 0) + 1
    return counts

# Helper function to merge a specific pair of ids into a new id
def merge(ids, pair, idx):
    """
    In a list of integers, replace all occurrences of the pair with the new id.
    Example: merge([1, 2, 3, 1, 2], (1, 2), 4) -> [4, 3, 4]
    """
    new_ids = []
    i = 0
    while i < len(ids):
        if i < len(ids) - 1 and ids[i] == pair[0] and ids[i+1] == pair[1]:
            new_ids.append(idx)
            i += 2
        else:
            new_ids.append(ids[i])
            i += 1
    return new_ids

class BpeTokenizer:
    """A from-scratch Byte-Pair Encoding Tokenizer."""

    def __init__(self):
        # The initial vocabulary is the 256 bytes
        self.vocab = {i: bytes([i]) for i in range(256)}
        # Merge rules, maps (int, int) -> int
        self.merges = {}
        # Regex pattern for pre-tokenization, similar to GPT-2
        self.pattern = r"""'s|'t|'re|'ve|'m|'ll|'d| ?[a-zA-Z]+| ?[0-9]+| ?[^a-zA-Z0-9\s]+|\s+"""

    def train(self, text, vocab_size, verbose=False):
        """
        Trains the tokenizer on a given text to learn the merge rules.
        
        Args:
            text (str): The text to train on.
            vocab_size (int): The desired final vocabulary size.
            verbose (bool): If True, prints progress during training.
        """
        assert vocab_size >= 256
        num_merges = vocab_size - 256

        # 1. Pre-tokenize the text into chunks
        text_chunks = re.findall(self.pattern, text)
        
        # 2. Encode each chunk into a list of integers (bytes)
        ids = [list(chunk.encode("utf-8")) for chunk in text_chunks]

        # 3. Iteratively learn the merge rules
        for i in range(num_merges):
            # Count frequencies of all pairs across all chunks
            stats = {}
            for chunk_ids in ids:
                chunk_stats = get_stats(chunk_ids)
                for pair, count in chunk_stats.items():
                    stats[pair] = stats.get(pair, 0) + count
            
            # Find the most frequent pair
            if not stats:
                break # No more pairs to merge
            top_pair = max(stats, key=stats.get)
            
            # The new token ID is the next available integer
            new_idx = 256 + i

            # 4. Apply the merge to all chunks
            ids = [merge(chunk_ids, top_pair, new_idx) for chunk_ids in ids]

            # 5. Store the merge rule and update the vocabulary
            self.merges[top_pair] = new_idx
            self.vocab[new_idx] = self.vocab[top_pair[0]] + self.vocab[top_pair[1]]

            if verbose:
                print(f"Merge {i+1}/{num_merges}: {top_pair} -> {new_idx} ({self.vocab[new_idx]})")

    def _encode_chunk(self, text_bytes):
        """Encodes a single chunk of text after it has been converted to bytes."""
        ids = list(text_bytes)
        while len(ids) >= 2:
            # Find the next best pair to merge
            stats = get_stats(ids)
            # Find the pair that appears earliest in our learned merge rules
            pair = min(stats, key=lambda p: self.merges.get(p, float("inf")))
            
            # If no known pairs are in this chunk, we're done
            if pair not in self.merges:
                break 
            
            # Merge the best pair
            new_idx = self.merges[pair]
            ids = merge(ids, pair, new_idx)
        return ids

    def encode(self, text):
        """
        Encodes a string into a list of token IDs.
        """
        tokens = []
        # Pre-tokenize the text
        chunks = re.findall(self.pattern, text)
        for chunk in chunks:
            chunk_bytes = chunk.encode("utf-8")
            chunk_tokens = self._encode_chunk(chunk_bytes)
            tokens.extend(chunk_tokens)
        return tokens

    def decode(self, ids):
        """
        Decodes a list of token IDs back into a string.
        """
        # Join the byte representations of all tokens
        text_bytes = b"".join(self.vocab[idx] for idx in ids)
        # Decode the bytes back to a string, replacing errors
        text = text_bytes.decode("utf-8", errors="replace")
        return text

    def save(self, file_prefix):
        """
        Saves the tokenizer's vocabulary and merge rules to a file.
        The model is saved in two files: `file_prefix.model` and `file_prefix.vocab`.
        """
        # Save the model file (merge rules)
        model_file = file_prefix + ".model"
        with open(model_file, 'w') as f:
            for (p0, p1), idx in self.merges.items():
                f.write(f"{p0} {p1}\n")

        # Save the vocabulary
        vocab_file = file_prefix + ".vocab"
        # Invert vocab to be serializable: bytes -> int
        inv_vocab = {v: k for k, v in self.vocab.items()}
        with open(vocab_file, 'w') as f:
            # We can't directly JSON dump bytes, so we'll convert them to a list of ints
            serializable_vocab = {json.dumps(list(k)): v for k, v in inv_vocab.items()}
            json.dump(serializable_vocab, f)

    def load(self, model_file):
        """
        Loads the tokenizer's state from a model file.
        """
        self.merges = {}
        self.vocab = {i: bytes([i]) for i in range(256)}

        with open(model_file, 'r', encoding="utf-8") as f:
            for i, line in enumerate(f):
                p0, p1 = map(int, line.strip().split())
                new_idx = 256 + i
                self.merges[(p0, p1)] = new_idx
                self.vocab[new_idx] = self.vocab[p0] + self.vocab[p1]


# --- Example Usage ---
if __name__ == "__main__":
    # 1. Initialize a new tokenizer
    tokenizer = BpeTokenizer()

    # 2. Get some training text
    # In a real scenario, this would be a large corpus from a file
    text = "A.c.e.s AI is an advanced, highly capable, and helpful AI assistant."
    text += " By building your own BPE Tokenizer, you control exactly how A.c.e.s AI perceives language."

    # 3. Train the tokenizer
    # A small vocab_size for demonstration. A real model would use ~50000.
    vocab_size = 300 
    print("Training tokenizer...")
    tokenizer.train(text, vocab_size, verbose=True)
    print("Training complete.\n")

    # 4. Test encoding and decoding
    test_string = "A.c.e.s AI perceives advanced languages."
    encoded = tokenizer.encode(test_string)
    decoded = tokenizer.decode(encoded)

    print(f"Original string: {test_string}")
    print(f"Encoded tokens: {encoded}")
    print(f"Decoded string: {decoded}")
    print(f"Vocab size: {len(tokenizer.vocab)}")
    assert test_string == decoded