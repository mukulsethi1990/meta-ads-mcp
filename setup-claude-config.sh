#!/bin/bash
# Setup Meta Ads MCP server in Claude Desktop config
# Run this on your Mac: bash setup-claude-config.sh

CONFIG_DIR="$HOME/Library/Application Support/Claude"
CONFIG_FILE="$CONFIG_DIR/claude_desktop_config.json"
SERVER_PATH="$(cd "$(dirname "$0")" && pwd)/build/server.js"

# Load token from .env
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
  TOKEN=$(grep '^META_ACCESS_TOKEN=' "$ENV_FILE" | cut -d'=' -f2-)
else
  echo "Error: .env file not found at $ENV_FILE"
  echo "Create it with: META_ACCESS_TOKEN=your_token_here"
  exit 1
fi

if [ -z "$TOKEN" ]; then
  echo "Error: META_ACCESS_TOKEN not found in .env"
  exit 1
fi

# Create config dir if needed
mkdir -p "$CONFIG_DIR"

# Build the meta-ads server entry
META_ADS_ENTRY=$(cat <<JSONEOF
{
    "command": "node",
    "args": ["$SERVER_PATH"],
    "env": {
      "META_ACCESS_TOKEN": "$TOKEN"
    }
  }
JSONEOF
)

if [ -f "$CONFIG_FILE" ]; then
  # Config exists — check if it has mcpServers
  if python3 -c "import json; d=json.load(open('$CONFIG_FILE')); assert 'mcpServers' in d" 2>/dev/null; then
    # Merge meta-ads into existing mcpServers (preserve other servers)
    python3 -c "
import json, sys
with open('$CONFIG_FILE') as f:
    config = json.load(f)
config['mcpServers']['meta-ads'] = {
    'command': 'node',
    'args': ['$SERVER_PATH'],
    'env': {'META_ACCESS_TOKEN': '$TOKEN'}
}
with open('$CONFIG_FILE', 'w') as f:
    json.dump(config, f, indent=2)
print('Updated existing config — added/replaced meta-ads server.')
print('Other MCP servers preserved:', [k for k in config['mcpServers'] if k != 'meta-ads'] or ['(none)'])
"
  else
    # Has JSON but no mcpServers key
    python3 -c "
import json
with open('$CONFIG_FILE') as f:
    config = json.load(f)
config['mcpServers'] = {
    'meta-ads': {
        'command': 'node',
        'args': ['$SERVER_PATH'],
        'env': {'META_ACCESS_TOKEN': '$TOKEN'}
    }
}
with open('$CONFIG_FILE', 'w') as f:
    json.dump(config, f, indent=2)
print('Added mcpServers section with meta-ads to existing config.')
"
  fi
else
  # No config file — create fresh
  python3 -c "
import json
config = {
    'mcpServers': {
        'meta-ads': {
            'command': 'node',
            'args': ['$SERVER_PATH'],
            'env': {'META_ACCESS_TOKEN': '$TOKEN'}
        }
    }
}
with open('$CONFIG_FILE', 'w') as f:
    json.dump(config, f, indent=2)
print('Created new Claude Desktop config with meta-ads server.')
"
fi

echo ""
echo "Config file: $CONFIG_FILE"
echo "Server path: $SERVER_PATH"
echo ""
echo "Now restart Claude Desktop for changes to take effect."
