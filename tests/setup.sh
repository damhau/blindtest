#!/bin/bash

echo "🎵 Blindtest App - Quick Start Setup"
echo "===================================="
echo ""

# Check if uv is installed
if ! command -v uv &> /dev/null; then
    echo "❌ uv is not installed. Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    echo "✓ uv installed successfully"
    echo "⚠️  Please restart your terminal or run: source $HOME/.cargo/env"
    exit 0
fi

echo "✓ uv found: $(uv --version)"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "⚠️  Please edit .env file with your API credentials:"
    echo "   - Spotify: https://developer.spotify.com/dashboard"
    echo "   - OpenAI: https://platform.openai.com/api-keys"
    echo ""
    read -p "Press Enter after you've updated the .env file..."
fi

# Create virtual environment and install dependencies
echo "📦 Creating virtual environment and installing dependencies..."
uv sync

echo ""
echo "✅ Setup complete!"
echo ""
echo "🚀 To start the server, run:"
echo "   uv run python app.py"
echo "   or"
echo "   source .venv/bin/activate && python app.py"
echo ""
echo "📱 Then open in your browser:"
echo "   Host: http://localhost:5000/host"
echo "   Player: http://localhost:5000/participant"
echo ""
