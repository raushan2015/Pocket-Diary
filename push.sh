#!/usr/bin/env bash

# Exit immediately on error
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

TARGET_BRANCH="main"
REMOTE="origin"

# Navigate to the repository root directory
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

echo -e "${BLUE}==> Git Push Helper for '${TARGET_BRANCH}' branch${NC}"

# Check if inside a git repository
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo -e "${RED}Error: Not inside a git repository.${NC}" >&2
    exit 1
fi

# Verify remote exists
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
    echo -e "${RED}Error: Remote '${REMOTE}' not found.${NC}" >&2
    exit 1
fi

# Get commit message from arguments or prompt user
COMMIT_MSG="$*"
if [ -z "$COMMIT_MSG" ]; then
    if [ -t 0 ]; then
        read -r -p "Enter commit message (press Enter for default): " USER_MSG
        COMMIT_MSG="$USER_MSG"
    fi
fi

# Fallback default message if empty
if [ -z "$COMMIT_MSG" ]; then
    COMMIT_MSG="Update: $(date '+%Y-%m-%d %H:%M:%S')"
fi

# Check for staged, unstaged, or untracked changes
CHANGES=false
if [ -n "$(git status --porcelain)" ]; then
    CHANGES=true
fi

if [ "$CHANGES" = true ]; then
    echo -e "${BLUE}==> Staging all changes...${NC}"
    git add -A

    echo -e "${BLUE}==> Committing changes with message: \"${COMMIT_MSG}\"...${NC}"
    git commit -m "$COMMIT_MSG"
else
    echo -e "${YELLOW}==> No working tree changes to commit.${NC}"
fi

# Check current branch
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Check if there are unpushed commits
if git rev-parse --verify "refs/remotes/${REMOTE}/${TARGET_BRANCH}" >/dev/null 2>&1; then
    UNPUSHED="$(git log "${REMOTE}/${TARGET_BRANCH}..HEAD" --oneline 2>/dev/null || true)"
    if [ "$CHANGES" = false ] && [ -z "$UNPUSHED" ]; then
        echo -e "${GREEN}==> Already up to date with ${REMOTE}/${TARGET_BRANCH}. Nothing to push.${NC}"
        exit 0
    fi
fi

# Push to GitHub
if [ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]; then
    echo -e "${YELLOW}Warning: Current local branch is '${CURRENT_BRANCH}', not '${TARGET_BRANCH}'.${NC}"
    echo -e "${BLUE}==> Pushing ${CURRENT_BRANCH} to ${REMOTE}/${TARGET_BRANCH}...${NC}"
    git push "$REMOTE" "${CURRENT_BRANCH}:${TARGET_BRANCH}"
else
    echo -e "${BLUE}==> Pushing to ${REMOTE}/${TARGET_BRANCH}...${NC}"
    git push "$REMOTE" "$TARGET_BRANCH"
fi

echo -e "${GREEN}✔ Successfully pushed to GitHub on branch '${TARGET_BRANCH}'!${NC}"
