#!/bin/bash

# GoLLM Service Setup Script
# This script automates the environment setup for running the Gemini-to-OpenAI bridge.

set -e

echo "🚀 Starting GoLLM Service Setup..."

# 1. Install dependencies
echo "📦 Installing npm dependencies..."
npm install

# 2. Install Playwright Browsers
echo "🌐 Installing Playwright Chromium browser..."
npx playwright install chromium

# 3. Setup Configuration
if [ ! -f "service.gollmrc.json" ]; then
    echo "📝 Creating service.gollmrc.json from template..."
    cp config.example.json service.gollmrc.json
    echo "✅ config.example.json copied to service.gollmrc.json"
    echo "⚠️  Please edit service.gollmrc.json to set your userDataDir if needed."
else
    echo "✅ service.gollmrc.json already exists."
fi

# 4. Ensure User Data Directory exists
USER_DATA_DIR=$(grep -oP '(?<="userDataDir": ")[^"]*' service.gollmrc.json || echo "~/.openclaw/gollm-playwright-profile")
# Expand tilde if present
eval USER_DATA_DIR=$USER_DATA_DIR
mkdir -p "$USER_DATA_DIR"
echo "📁 Browser profile directory ensured at: $USER_DATA_DIR"

echo "-------------------------------------------------------------------"
echo "✅ Setup Complete!"
echo "👉 Next steps:"
echo "   1. Run 'npm run build' to compile the project."
echo "   2. Launch the service: 'npm start' or use systemctl --user start gollm-service"
echo "   3. Open your browser and sign in to Gemini to initialize the profile."
echo "-------------------------------------------------------------------"
