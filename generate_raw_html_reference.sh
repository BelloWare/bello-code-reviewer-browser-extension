#!/bin/bash

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: 'jq' is not installed. Please install it to parse JSON output."
    exit 1
fi

# Check if a prompt was provided
if [ -z "$1" ]; then
  echo "Usage: $0 <prompt>"
  exit 1
fi

PROMPT="$1"

# Escape the prompt for JSON safety using jq to avoid breaking on quotes
JSON_PAYLOAD=$(jq -n \
                  --arg model "google/gemini-3-pro-preview" \
                  --arg content "$PROMPT" \
                  '{model: $model, messages: [{role: "user", content: $content}]}')

# Make the request
RESPONSE=$(curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPEN_ROUTER_KEY" \
  -d "$JSON_PAYLOAD")

# Check for curl execution error
if [ $? -ne 0 ]; then
    echo "Error: Curl request failed."
    exit 1
fi

# Check for API errors in the JSON response
API_ERROR=$(echo "$RESPONSE" | jq -r '.error.message // empty')

if [ -n "$API_ERROR" ]; then
    echo "API Error: $API_ERROR"
    exit 1
fi

# Extract and output the content
CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty')

if [ -z "$CONTENT" ]; then
    echo "Error: No content returned. Raw response:"
    echo "$RESPONSE"
    exit 1
fi

echo "$CONTENT"
