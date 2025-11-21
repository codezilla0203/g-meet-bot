#!/bin/bash

# ============================================
# CXFlow Meeting Bot - EC2 CentOS Deployment Script
# ============================================
# This script automates the deployment process on a fresh EC2 CentOS/Amazon Linux instance
# Run this script on your EC2 instance after connecting via SSH

set -e  # Exit on any error

echo "=================================================="
echo "CXFlow Meeting Bot - EC2 Deployment Script"
echo "=================================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    print_error "Please do not run this script as root (without sudo)"
    exit 1
fi

echo "Starting deployment process..."
echo ""

# Detect package manager
if command -v dnf &> /dev/null; then
    PKG_MANAGER="dnf"
else
    PKG_MANAGER="yum"
fi
print_status "Detected package manager: $PKG_MANAGER"

# Step 1: Update system
print_status "Updating system packages..."
sudo $PKG_MANAGER update -y

# Step 2: Install Node.js
print_status "Installing Node.js 20.x..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo $PKG_MANAGER install -y nodejs
else
    print_warning "Node.js already installed: $(node --version)"
fi

# Step 3: Install Git
print_status "Installing Git..."
sudo $PKG_MANAGER install -y git

# Step 4: Install Puppeteer dependencies
print_status "Installing Chromium dependencies..."
sudo $PKG_MANAGER install -y \
    alsa-lib \
    atk \
    cups-libs \
    gtk3 \
    ipa-gothic-fonts \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXext \
    libXi \
    libXrandr \
    libXScrnSaver \
    libXtst \
    pango \
    xorg-x11-fonts-100dpi \
    xorg-x11-fonts-75dpi \
    xorg-x11-fonts-cyrillic \
    xorg-x11-fonts-misc \
    xorg-x11-fonts-Type1 \
    xorg-x11-utils \
    liberation-fonts \
    nss \
    nspr \
    at-spi2-atk \
    at-spi2-core \
    mesa-libgbm

# Step 5: Install FFmpeg
print_status "Installing FFmpeg..."
if ! command -v ffmpeg &> /dev/null; then
    # Detect OS version and install EPEL accordingly
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        
        if [[ "$ID" == "amzn" ]]; then
            if [[ "$VERSION_ID" == "2023" ]] || [[ "$VERSION_ID" == "2" && "$NAME" == *"2023"* ]]; then
                # Amazon Linux 2023
                print_status "Detected Amazon Linux 2023"
                print_warning "FFmpeg requires RPM Fusion on AL2023..."
                
                # Install RPM Fusion Free repository
                sudo dnf install -y https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm 2>/dev/null || {
                    # Fallback: try with hardcoded version
                    sudo dnf install -y https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-39.noarch.rpm 2>/dev/null || {
                        print_warning "RPM Fusion installation failed, trying alternative..."
                    }
                }
                
                # Install FFmpeg from RPM Fusion
                sudo dnf install -y ffmpeg 2>/dev/null || {
                    print_warning "FFmpeg from RPM Fusion failed, using ffmpeg-static from npm instead..."
                    # Note: The project already includes ffmpeg-static as a dependency
                    print_status "Will use bundled ffmpeg-static from npm"
                }
            elif command -v amazon-linux-extras &> /dev/null; then
                # Amazon Linux 2 (with amazon-linux-extras)
                print_status "Detected Amazon Linux 2"
                sudo amazon-linux-extras install -y epel
                sudo yum install -y ffmpeg
            else
                # Fallback for Amazon Linux without extras
                print_status "Detected Amazon Linux (trying dnf)"
                sudo dnf install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm 2>/dev/null || true
                sudo dnf install -y --allowerasing ffmpeg
            fi
        elif [[ "$VERSION_ID" == "8" ]] || [[ "$VERSION_ID" =~ ^8\. ]]; then
            # CentOS/RHEL 8
            print_status "Detected CentOS/RHEL 8"
            sudo dnf install -y epel-release
            sudo dnf config-manager --set-enabled powertools || sudo dnf config-manager --set-enabled PowerTools || true
            sudo dnf install -y ffmpeg
        elif [[ "$VERSION_ID" == "9" ]] || [[ "$VERSION_ID" =~ ^9\. ]]; then
            # CentOS/RHEL 9
            print_status "Detected CentOS/RHEL 9"
            sudo dnf install -y epel-release
            sudo dnf config-manager --set-enabled crb || true
            sudo dnf install -y ffmpeg
        else
            # CentOS/RHEL 7 or older
            print_status "Detected CentOS/RHEL 7 or older"
            sudo yum install -y epel-release
            sudo yum install -y ffmpeg
        fi
    else
        # Fallback for older systems
        print_warning "Could not detect OS, trying default installation..."
        if command -v dnf &> /dev/null; then
            sudo dnf install -y ffmpeg || sudo dnf install -y epel-release && sudo dnf install -y ffmpeg
        else
            sudo yum install -y epel-release && sudo yum install -y ffmpeg
        fi
    fi
else
    print_warning "FFmpeg already installed: $(ffmpeg -version | head -n1)"
fi

# Step 6: Install project dependencies
print_status "Installing project dependencies..."
if [ -f "package.json" ]; then
    npm install
else
    print_error "package.json not found. Make sure you're in the project directory."
    exit 1
fi

# Step 7: Set up environment file
print_status "Setting up environment file..."
if [ ! -f ".env" ]; then
    cat > .env << EOF
# Server Configuration
PORT=3000

# Security (IMPORTANT: Change this in production!)
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Bot Configuration
BOT_MAX_LIFETIME_MINUTES=90

# Optional: OpenAI Integration
# Uncomment and add your key for AI-powered summaries
# OPENAI_API_KEY=sk-your-openai-key-here
# OPENAI_MODEL=gpt-3.5-turbo
EOF
    print_status "Created .env file with secure JWT_SECRET"
    print_warning "Remember to add your OPENAI_API_KEY if you want AI summaries"
else
    print_warning ".env file already exists. Skipping creation."
fi

# Step 8: Install PM2
print_status "Installing PM2 process manager..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
else
    print_warning "PM2 already installed: $(pm2 --version)"
fi

# Step 9: Start application with PM2
print_status "Starting application with PM2..."
pm2 delete meeting-bot 2>/dev/null || true  # Delete if exists
pm2 start src/server.js --name "meeting-bot"
pm2 save
print_status "Application started successfully"

# Step 10: Set up PM2 startup
print_status "Setting up PM2 to start on boot..."
pm2 startup | grep "sudo" | bash || print_warning "PM2 startup already configured"

# Step 11: Configure firewall
print_status "Configuring firewall..."
if systemctl is-active --quiet firewalld; then
    sudo firewall-cmd --permanent --add-port=3000/tcp
    sudo firewall-cmd --reload
    print_status "Firewall configured to allow port 3000"
else
    print_warning "firewalld not running. Make sure your security group allows port 3000"
fi

# Step 12: Create backup directory
print_status "Creating backup directory..."
mkdir -p ~/backups

echo ""
echo "=================================================="
echo -e "${GREEN}Deployment Complete!${NC}"
echo "=================================================="
echo ""
echo "Your application is now running at:"
echo -e "  ${GREEN}http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):3000${NC}"
echo ""
echo "Useful commands:"
echo "  pm2 status          - Check application status"
echo "  pm2 logs meeting-bot - View application logs"
echo "  pm2 restart meeting-bot - Restart application"
echo "  pm2 monit           - Monitor resources"
echo ""
echo "Next steps:"
echo "  1. Make sure your EC2 security group allows port 3000"
echo "  2. (Optional) Set up Nginx as reverse proxy (see DEPLOYMENT_EC2_CENTOS.md)"
echo "  3. (Optional) Configure SSL with Let's Encrypt"
echo "  4. (Optional) Add your OPENAI_API_KEY to .env for AI summaries"
echo ""
print_warning "IMPORTANT: Your JWT_SECRET has been generated automatically."
print_warning "Keep your .env file secure and never commit it to version control!"
echo ""

