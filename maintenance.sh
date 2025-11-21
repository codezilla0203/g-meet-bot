#!/bin/bash

# ============================================
# CXFlow Meeting Bot - Maintenance Script
# ============================================
# Common maintenance tasks for EC2 deployment
# Run this script on your EC2 instance for routine maintenance

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Functions
print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Main menu
show_menu() {
    clear
    echo "============================================"
    echo "  CXFlow Meeting Bot - Maintenance Menu"
    echo "============================================"
    echo ""
    echo "1.  View Application Status"
    echo "2.  View Application Logs"
    echo "3.  Restart Application"
    echo "4.  Update Application"
    echo "5.  Backup Database"
    echo "6.  Clean Old Recordings"
    echo "7.  Check Disk Space"
    echo "8.  Check System Resources"
    echo "9.  View Recent Errors"
    echo "10. Update System Packages"
    echo "11. Test Application Health"
    echo "12. View Database Info"
    echo "0.  Exit"
    echo ""
    echo -n "Select option: "
}

# 1. View Application Status
view_status() {
    print_header "Application Status"
    
    if command -v pm2 &> /dev/null; then
        pm2 status
    elif systemctl is-active --quiet meeting-bot; then
        sudo systemctl status meeting-bot
    else
        print_error "Application is not running or process manager not found"
    fi
    
    echo ""
    read -p "Press Enter to continue..."
}

# 2. View Application Logs
view_logs() {
    print_header "Application Logs"
    
    echo "Showing last 50 lines (press Ctrl+C to exit follow mode)..."
    echo ""
    
    if command -v pm2 &> /dev/null; then
        pm2 logs meeting-bot --lines 50
    elif systemctl is-active --quiet meeting-bot; then
        sudo journalctl -u meeting-bot -n 50 -f
    else
        print_error "Process manager not found"
    fi
}

# 3. Restart Application
restart_app() {
    print_header "Restart Application"
    
    read -p "Are you sure you want to restart the application? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        print_warning "Restart cancelled"
        return
    fi
    
    if command -v pm2 &> /dev/null; then
        pm2 restart meeting-bot
        print_success "Application restarted with PM2"
    elif systemctl is-active --quiet meeting-bot; then
        sudo systemctl restart meeting-bot
        print_success "Application restarted with systemd"
    else
        print_error "Process manager not found"
    fi
    
    echo ""
    read -p "Press Enter to continue..."
}

# 4. Update Application
update_app() {
    print_header "Update Application"
    
    cd ~/g-meet-node || { print_error "Project directory not found"; return; }
    
    print_warning "This will pull latest changes from Git and restart the application"
    read -p "Continue? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        print_warning "Update cancelled"
        return
    fi
    
    echo "Pulling latest changes..."
    git pull origin main || git pull origin master
    
    echo "Installing dependencies..."
    npm install
    
    echo "Restarting application..."
    if command -v pm2 &> /dev/null; then
        pm2 restart meeting-bot
    elif systemctl is-active --quiet meeting-bot; then
        sudo systemctl restart meeting-bot
    fi
    
    print_success "Application updated successfully"
    
    echo ""
    read -p "Press Enter to continue..."
}

# 5. Backup Database
backup_database() {
    print_header "Backup Database"
    
    BACKUP_DIR=~/backups
    mkdir -p "$BACKUP_DIR"
    
    DB_FILE=~/g-meet-node/database.sqlite
    
    if [ ! -f "$DB_FILE" ]; then
        print_error "Database file not found at $DB_FILE"
        return
    fi
    
    BACKUP_NAME="database-$(date +%Y%m%d-%H%M%S).sqlite"
    BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
    
    cp "$DB_FILE" "$BACKUP_PATH"
    
    print_success "Database backed up to: $BACKUP_PATH"
    
    # Show backup size
    SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
    echo "Backup size: $SIZE"
    
    # List recent backups
    echo ""
    echo "Recent backups:"
    ls -lht "$BACKUP_DIR" | head -6
    
    echo ""
    read -p "Press Enter to continue..."
}

# 6. Clean Old Recordings
clean_recordings() {
    print_header "Clean Old Recordings"
    
    RUNTIME_DIR=~/g-meet-node/runtime/bots
    
    if [ ! -d "$RUNTIME_DIR" ]; then
        print_warning "Runtime directory not found"
        return
    fi
    
    echo "Current disk usage of recordings:"
    du -sh "$RUNTIME_DIR"
    echo ""
    
    echo "This will delete recordings older than 7 days"
    read -p "Continue? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        print_warning "Cleanup cancelled"
        return
    fi
    
    # Find and delete old directories
    DELETED=$(find "$RUNTIME_DIR" -type d -mtime +7 2>/dev/null | wc -l)
    find "$RUNTIME_DIR" -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
    
    print_success "Deleted $DELETED old recording directories"
    
    echo ""
    echo "New disk usage:"
    du -sh "$RUNTIME_DIR"
    
    echo ""
    read -p "Press Enter to continue..."
}

# 7. Check Disk Space
check_disk_space() {
    print_header "Disk Space"
    
    df -h
    
    echo ""
    echo "Largest directories:"
    du -h --max-depth=1 ~/g-meet-node 2>/dev/null | sort -hr | head -10
    
    echo ""
    read -p "Press Enter to continue..."
}

# 8. Check System Resources
check_resources() {
    print_header "System Resources"
    
    echo "CPU and Memory Usage:"
    echo ""
    
    # CPU
    echo "CPU Usage:"
    top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print 100 - $1"%"}'
    
    echo ""
    
    # Memory
    echo "Memory Usage:"
    free -h
    
    echo ""
    
    # Top processes
    echo "Top 10 processes by memory:"
    ps aux --sort=-%mem | head -11
    
    echo ""
    read -p "Press Enter to continue..."
}

# 9. View Recent Errors
view_errors() {
    print_header "Recent Errors"
    
    echo "Searching for errors in logs..."
    echo ""
    
    if command -v pm2 &> /dev/null; then
        pm2 logs meeting-bot --lines 100 --err
    elif systemctl is-active --quiet meeting-bot; then
        sudo journalctl -u meeting-bot -p err -n 50
    else
        print_error "Process manager not found"
    fi
    
    echo ""
    read -p "Press Enter to continue..."
}

# 10. Update System Packages
update_system() {
    print_header "Update System Packages"
    
    print_warning "This will update all system packages"
    read -p "Continue? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        print_warning "Update cancelled"
        return
    fi
    
    sudo yum update -y
    
    print_success "System packages updated"
    
    echo ""
    read -p "Press Enter to continue..."
}

# 11. Test Application Health
test_health() {
    print_header "Application Health Test"
    
    # Check if process is running
    if command -v pm2 &> /dev/null; then
        if pm2 list | grep -q "meeting-bot.*online"; then
            print_success "Process is running (PM2)"
        else
            print_error "Process is not running"
            return
        fi
    elif systemctl is-active --quiet meeting-bot; then
        print_success "Process is running (systemd)"
    else
        print_error "Process is not running"
        return
    fi
    
    # Check if port is listening
    if sudo netstat -tulpn | grep -q ":3000"; then
        print_success "Application is listening on port 3000"
    else
        print_error "Application is not listening on port 3000"
    fi
    
    # Check HTTP response
    if command -v curl &> /dev/null; then
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 || echo "000")
        if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ]; then
            print_success "HTTP endpoint responding (HTTP $HTTP_CODE)"
        else
            print_warning "HTTP endpoint returned: HTTP $HTTP_CODE"
        fi
    fi
    
    # Check database file
    if [ -f ~/g-meet-node/database.sqlite ]; then
        print_success "Database file exists"
        DB_SIZE=$(du -h ~/g-meet-node/database.sqlite | cut -f1)
        echo "   Size: $DB_SIZE"
    else
        print_error "Database file not found"
    fi
    
    # Check disk space
    DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
    if [ "$DISK_USAGE" -lt 80 ]; then
        print_success "Disk space OK ($DISK_USAGE% used)"
    else
        print_warning "Disk space high ($DISK_USAGE% used)"
    fi
    
    # Check memory
    MEM_USAGE=$(free | awk 'NR==2 {printf "%.0f", $3/$2*100}')
    if [ "$MEM_USAGE" -lt 80 ]; then
        print_success "Memory usage OK ($MEM_USAGE% used)"
    else
        print_warning "Memory usage high ($MEM_USAGE% used)"
    fi
    
    echo ""
    read -p "Press Enter to continue..."
}

# 12. View Database Info
view_database_info() {
    print_header "Database Information"
    
    DB_FILE=~/g-meet-node/database.sqlite
    
    if [ ! -f "$DB_FILE" ]; then
        print_error "Database file not found"
        return
    fi
    
    # File info
    echo "File: $DB_FILE"
    echo "Size: $(du -h "$DB_FILE" | cut -f1)"
    echo "Modified: $(stat -c %y "$DB_FILE" 2>/dev/null || stat -f %Sm "$DB_FILE")"
    echo ""
    
    # Query database if sqlite3 is available
    if command -v sqlite3 &> /dev/null; then
        echo "Users count:"
        sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "N/A"
        
        echo ""
        echo "Bots count:"
        sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM bots;" 2>/dev/null || echo "N/A"
        
        echo ""
        echo "Recent bots:"
        sqlite3 "$DB_FILE" "SELECT id, status, createdAt FROM bots ORDER BY createdAt DESC LIMIT 5;" 2>/dev/null || echo "N/A"
    else
        print_warning "sqlite3 not installed. Install with: sudo yum install -y sqlite"
    fi
    
    echo ""
    read -p "Press Enter to continue..."
}

# Main loop
while true; do
    show_menu
    read choice
    
    case $choice in
        1) view_status ;;
        2) view_logs ;;
        3) restart_app ;;
        4) update_app ;;
        5) backup_database ;;
        6) clean_recordings ;;
        7) check_disk_space ;;
        8) check_resources ;;
        9) view_errors ;;
        10) update_system ;;
        11) test_health ;;
        12) view_database_info ;;
        0) 
            echo "Goodbye!"
            exit 0
            ;;
        *)
            print_error "Invalid option"
            sleep 2
            ;;
    esac
done

