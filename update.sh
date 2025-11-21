#!/bin/bash

# ============================================
# CXFlow Meeting Bot - Quick Update Script
# ============================================
# Updates the application with the latest code
# Run this on your EC2 instance: ./update.sh

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "============================================"
echo "  CXFlow Meeting Bot - Update Script"
echo "============================================"
echo ""

# Check if in correct directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: package.json not found${NC}"
    echo "Please run this script from the project directory"
    exit 1
fi

echo -e "${YELLOW}This will:${NC}"
echo "  1. Pull latest changes from Git"
echo "  2. Install/update dependencies"
echo "  3. Restart the application"
echo ""

read -p "Continue? (y/N): " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Update cancelled"
    exit 0
fi

echo ""
echo "Step 1: Pulling latest changes..."
echo "----------------------------------------"

# Check if git repo
if [ -d ".git" ]; then
    # Stash any local changes
    if [ -n "$(git status --porcelain)" ]; then
        echo -e "${YELLOW}Stashing local changes...${NC}"
        git stash
    fi
    
    # Pull latest
    git pull origin main 2>/dev/null || git pull origin master 2>/dev/null || {
        echo -e "${RED}Failed to pull from Git${NC}"
        exit 1
    }
    
    echo -e "${GREEN}✓ Code updated${NC}"
else
    echo -e "${YELLOW}Not a git repository, skipping pull${NC}"
fi

echo ""
echo "Step 2: Installing/updating dependencies..."
echo "----------------------------------------"
npm install

echo -e "${GREEN}✓ Dependencies updated${NC}"

echo ""
echo "Step 3: Restarting application..."
echo "----------------------------------------"

# Detect and restart with appropriate process manager
if command -v pm2 &> /dev/null && pm2 list 2>/dev/null | grep -q "meeting-bot"; then
    pm2 restart meeting-bot
    echo -e "${GREEN}✓ Application restarted with PM2${NC}"
    echo ""
    echo "View status: pm2 status"
    echo "View logs: pm2 logs meeting-bot"
elif systemctl list-units --type=service --all | grep -q "meeting-bot.service"; then
    sudo systemctl restart meeting-bot
    echo -e "${GREEN}✓ Application restarted with systemd${NC}"
    echo ""
    echo "View status: sudo systemctl status meeting-bot"
    echo "View logs: sudo journalctl -u meeting-bot -f"
else
    echo -e "${YELLOW}No process manager detected${NC}"
    echo "Please restart the application manually"
fi

echo ""
echo "============================================"
echo -e "${GREEN}Update Complete!${NC}"
echo "============================================"
echo ""

# Show current version if available
if [ -f "package.json" ] && command -v node &> /dev/null; then
    VERSION=$(node -p "require('./package.json').version")
    echo "Current version: $VERSION"
fi

# Show last commit if git repo
if [ -d ".git" ]; then
    echo "Last commit:"
    git log -1 --pretty=format:"  %h - %s (%ar)" 2>/dev/null || true
    echo ""
fi

echo ""

