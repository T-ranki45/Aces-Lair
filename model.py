import torch
import torch.nn as nn
import torch.nn.functional as F
import math

class PositionalEncoding(nn.Module):
    """
    Injects some information about the relative or absolute position of the tokens
    in the sequence. We use sine and cosine functions of different frequencies.
    """
    def __init__(self, d_model, max_len=5000):
        super().__init__()
        # Create a matrix of [max_len, d_model] representing the positional encodings
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        # Div term calculation for the sine/cosine waves
        # This creates geometric progression of wavelengths from 2pi to 10000*2pi
        div_term = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        
        # Apply sine to even indices and cosine to odd indices
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        
        # Register as a buffer (it's part of the state_dict but not a trained parameter)
        self.register_buffer('pe', pe.unsqueeze(0))

    def forward(self, x):
        # x shape: [batch_size, seq_len, d_model]
        # We add the positional encoding to the input embeddings
        # Slicing self.pe to match the current sequence length of x
        return x + self.pe[:, :x.size(1)]

class MultiHeadSelfAttention(nn.Module):
    """
    The core of the Transformer. Allows the model to jointly attend to 
    information from different representation subspaces at different positions.
    """
    def __init__(self, d_model, num_heads, dropout=0.1):
        super().__init__()
        assert d_model % num_heads == 0, "d_model must be divisible by num_heads"
        
        self.d_model = d_model
        self.num_heads = num_heads
        self.d_k = d_model // num_heads # Dimension of each head
        
        # Linear projections for Query, Key, and Value
        self.W_q = nn.Linear(d_model, d_model)
        self.W_k = nn.Linear(d_model, d_model)
        self.W_v = nn.Linear(d_model, d_model)
        
        # Output projection
        self.W_o = nn.Linear(d_model, d_model)
        
        self.dropout = nn.Dropout(dropout)

    def scaled_dot_product_attention(self, Q, K, V, mask=None):
        # Optimization: Use PyTorch's built-in Flash Attention if available
        # This is significantly faster and uses less memory while keeping results identical
        attn_mask = mask.bool() if mask is not None else None
        
        return F.scaled_dot_product_attention(
            Q, K, V, 
            attn_mask=attn_mask, 
            dropout_p=self.dropout.p if self.training else 0.0
        )

    def forward(self, x, mask=None):
        batch_size, seq_len, _ = x.size()
        
        # Linear projections & split into heads
        # View transforms [batch, seq, d_model] -> [batch, seq, heads, d_k]
        # Transpose moves heads dimension: [batch, heads, seq, d_k]
        Q = self.W_q(x).view(batch_size, seq_len, self.num_heads, self.d_k).transpose(1, 2)
        K = self.W_k(x).view(batch_size, seq_len, self.num_heads, self.d_k).transpose(1, 2)
        V = self.W_v(x).view(batch_size, seq_len, self.num_heads, self.d_k).transpose(1, 2)
        
        # Apply Attention Mechanism
        attn_output = self.scaled_dot_product_attention(Q, K, V, mask)
        
        # Concatenate heads
        # Transpose back: [batch, seq, heads, d_k] -> Reshape: [batch, seq, d_model]
        attn_output = attn_output.transpose(1, 2).contiguous().view(batch_size, seq_len, self.d_model)
        
        # Final linear projection
        return self.W_o(attn_output)

class FeedForward(nn.Module):
    """
    A simple fully connected feed-forward network applied to each position separately and identically.
    """
    def __init__(self, d_model, d_ff, dropout=0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(d_model, d_ff),
            nn.GELU(), # GELU is standard for modern Transformers (like GPT)
            nn.Dropout(dropout),
            nn.Linear(d_ff, d_model),
            nn.Dropout(dropout)
        )

    def forward(self, x):
        return self.net(x)

class TransformerBlock(nn.Module):
    """
    A single block of the Transformer, consisting of:
    1. Multi-Head Attention
    2. Feed-Forward Network
    With Residual connections and LayerNorm around each.
    """
    def __init__(self, d_model, num_heads, d_ff, dropout=0.1):
        super().__init__()
        self.attention = MultiHeadSelfAttention(d_model, num_heads, dropout)
        self.feed_forward = FeedForward(d_model, d_ff, dropout)
        
        # Layer Normalization
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        
        self.dropout = nn.Dropout(dropout)

    def forward(self, x, mask=None):
        # Pre-Norm Architecture (standard in GPT-2/3)
        # We normalize *before* the operation, then add residual *after*.
        
        # 1. Attention sub-layer
        _x = self.norm1(x)
        attn_out = self.attention(_x, mask)
        x = x + self.dropout(attn_out) # Residual connection
        
        # 2. Feed-Forward sub-layer
        _x = self.norm2(x)
        ff_out = self.feed_forward(_x)
        x = x + self.dropout(ff_out) # Residual connection
        
        return x

class AcesGPT(nn.Module):
    """
    The full Decoder-Only Transformer Model (GPT style).
    """
    def __init__(self, vocab_size, d_model, num_heads, num_layers, d_ff, max_seq_len, dropout=0.1):
        super().__init__()
        self.token_embedding = nn.Embedding(vocab_size, d_model)
        self.positional_encoding = PositionalEncoding(d_model, max_seq_len)
        
        # Stack multiple Transformer Blocks
        self.layers = nn.ModuleList([
            TransformerBlock(d_model, num_heads, d_ff, dropout) 
            for _ in range(num_layers)
        ])
        
        self.final_norm = nn.LayerNorm(d_model)
        self.lm_head = nn.Linear(d_model, vocab_size, bias=False)

    def forward(self, x):
        # x shape: [batch_size, seq_len] (token indices)
        batch_size, seq_len = x.size()
        
        # Create causal mask (look-ahead mask)
        # Ensures position i can only attend to positions <= i
        # Shape: [1, 1, seq_len, seq_len] for broadcasting
        mask = torch.tril(torch.ones(seq_len, seq_len)).to(x.device)
        mask = mask.unsqueeze(0).unsqueeze(0)
        
        # 1. Embeddings + Positional Encoding
        x = self.token_embedding(x)
        x = self.positional_encoding(x)
        
        # 2. Pass through Transformer Blocks
        for layer in self.layers:
            x = layer(x, mask)
            
        # 3. Final Norm
        x = self.final_norm(x)
        
        # 4. Project to vocabulary size to get logits
        logits = self.lm_head(x)
        return logits

    def generate(self, idx, max_new_tokens):
        """
        Generates new tokens based on a starting context.
        idx is (B, T) array of indices in the current context.
        """
        for _ in range(max_new_tokens):
            # Crop idx to the last block_size tokens to prevent context overflow
            idx_cond = idx[:, -self.positional_encoding.pe.size(1):]
            # Get the model's predictions (logits)
            logits = self(idx_cond)
            # Focus only on the last time step's logits
            logits = logits[:, -1, :] # Shape becomes (B, C)
            # Apply softmax to get probabilities
            probs = nn.functional.softmax(logits, dim=-1)
            # Sample from the probability distribution
            idx_next = torch.multinomial(probs, num_samples=1) # Shape (B, 1)
            # Append the new token to the running sequence
            idx = torch.cat((idx, idx_next), dim=1) # Shape (B, T+1)
        return idx

# Quick test block to verify the architecture runs
if __name__ == "__main__":
    # Example Hyperparameters
    vocab_size = 1000
    d_model = 256
    num_heads = 4
    num_layers = 4
    d_ff = 1024
    max_seq_len = 128
    
    model = AcesGPT(vocab_size, d_model, num_heads, num_layers, d_ff, max_seq_len)
    
    # Create dummy input (Batch Size=2, Sequence Length=10)
    input_data = torch.randint(0, vocab_size, (2, 10))
    output = model(input_data)
    
    print(f"A.c.e.s AI Model Architecture Initialized.")
    print(f"Input shape: {input_data.shape}")
    print(f"Output logits shape: {output.shape} (Batch, Seq, Vocab)")