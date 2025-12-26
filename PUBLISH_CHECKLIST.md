# SmartBin AI - Public Release Checklist

This checklist will guide you through safely publishing your SmartBin AI integration to GitHub.

## Pre-Publication Checklist

### 1. Clean Up Temporary Files

Remove development/temporary files that shouldn't be public:

```bash
cd /home/strator/claude-homeassistant/temp/smartbin_ai

# Remove temporary documentation
rm -f CRITICAL_STATUS.md
rm -f DEPLOYMENT_STATUS.md
rm -f FINAL_STATUS.md
rm -f FINAL_SUMMARY.md
rm -f RENAME_COMPLETE.md
rm -f REPOSITORY_READY.md
rm -f SECURITY_COMPLETE.md
rm -f SECURITY_FIX.md
rm -f SETUP_COMPLETE.md
rm -f STATUS.md
rm -f HACS_SETUP.md
rm -f README_REPO.md

# Remove temporary fix scripts
rm -f fix_syntax.py
rm -f manual_fix.py

# Remove this checklist after completion
# rm -f PUBLISH_CHECKLIST.md
```

### 2. Initialize New Git Repository

The current directory is part of a larger git repo. Create a standalone repo:

```bash
# Make sure you're in the smartbin_ai directory
cd /home/strator/claude-homeassistant/temp/smartbin_ai

# Remove any git connection to parent repo (if needed)
rm -rf .git

# Initialize a fresh git repository
git init

# Add all files (respects .gitignore)
git add .

# Verify what will be committed
git status
```

### 3. Review Staged Files

Verify that ONLY these types of files are staged:

**Should be included:**
- ✅ `custom_components/` directory
- ✅ `README.md`
- ✅ `LICENSE`
- ✅ `.gitignore`
- ✅ `.env.example`
- ✅ `.github/` directory
- ✅ `hacs.json`
- ✅ `RELEASE_NOTES.md`
- ✅ `smartbin_ai.png`
- ✅ `SECURITY_AUDIT.md` (optional, but recommended)

**Should NOT be included:**
- ❌ Any `*_STATUS.md` files
- ❌ Any `*_COMPLETE.md` files
- ❌ `.env` files (only `.env.example` is OK)
- ❌ `.claude/` directory
- ❌ `fix_syntax.py` or `manual_fix.py`
- ❌ Any personal information or credentials

If unwanted files appear in `git status`, add them to `.gitignore` and run `git reset` and `git add .` again.

### 4. Create Initial Commit

```bash
# Create initial commit with clean history
git commit -m "Initial commit: SmartBin AI Home Assistant Integration

- NFC-triggered AI-powered smart bin inventory management
- Vision AI image analysis using Z.AI API
- Mobile-friendly photo upload interface
- Inventory tracking with multiple dashboard themes
- HACS integration ready

🤖 Generated with Claude Code
"

# Verify commit
git log --oneline
```

### 5. Add GitHub Remote

```bash
# Add your GitHub repository as remote
git remote add origin https://github.com/birchcoin/smartbin_ai_ha.git

# Or using SSH (recommended):
# git remote add origin git@github.com:birchcoin/smartbin_ai_ha.git

# Verify remote
git remote -v
```

### 6. Create GitHub Repository

1. Go to https://github.com/new
2. Repository name: `smartbin_ai_ha`
3. Description: "NFC-triggered AI-powered smart bin inventory management for Home Assistant"
4. Public repository
5. **DO NOT** initialize with README, .gitignore, or license (we already have these)
6. Click "Create repository"

### 7. Push to GitHub

```bash
# Push to GitHub
git branch -M main
git push -u origin main
```

### 8. Configure GitHub Repository Settings

1. Go to repository settings
2. Add topics: `home-assistant`, `hacs`, `smart-home`, `nfc`, `ai`, `inventory-management`
3. Add description: "NFC-triggered AI-powered smart bin inventory management for Home Assistant"
4. Add website: (your documentation URL if you have one)

### 9. Create GitHub Release (for HACS)

```bash
# Create and push a version tag
git tag -a v1.0.0 -m "Release version 1.0.0

- Initial public release
- NFC-triggered smart bin uploads
- AI-powered image analysis
- Mobile-friendly interface
- Multiple dashboard themes
"

git push origin v1.0.0
```

Then on GitHub:
1. Go to Releases → Draft a new release
2. Choose tag: `v1.0.0`
3. Release title: `v1.0.0 - Initial Release`
4. Copy content from `RELEASE_NOTES.md`
5. Publish release

### 10. Submit to HACS

Once the repository is live and has a release:

1. Fork https://github.com/hacs/default
2. Add your repository to `custom_components/integration` in the fork
3. Create pull request with title: "Add SmartBin AI integration"
4. Wait for HACS team review

## Security Verification

Before pushing, verify:

- [ ] No `.env` files in repository
- [ ] No API keys or passwords in code
- [ ] No personal email addresses you want to hide
- [ ] No IP addresses or hostnames
- [ ] `.gitignore` is properly configured
- [ ] Only intended files are staged
- [ ] `SECURITY_AUDIT.md` shows all checks passed

## Post-Publication Tasks

1. **Update README.md** with:
   - Installation badges
   - Screenshots
   - Demo videos (if available)

2. **Monitor Issues**:
   - Watch for security reports
   - Respond to installation questions

3. **Set up GitHub Actions** (optional):
   - The `.github/workflows/validate.yml` is already configured
   - Verify it runs successfully on push

## Troubleshooting

### Git says "repository already exists"

The GitHub repo was created with a README. Either:
- Delete and recreate the repo without initializing it, OR
- Pull first: `git pull origin main --allow-unrelated-histories`

### Files I want to exclude are still showing in git status

1. Add them to `.gitignore`
2. Run `git rm --cached <filename>` for already tracked files
3. Run `git add .` again

### Worried about email addresses in commits

If you want to hide your email:
```bash
git config user.email "your-github-username@users.noreply.github.com"
git commit --amend --reset-author
```

## Contact

For security issues, create a GitHub Security Advisory or contact via GitHub Issues.

---

**Ready to publish?** Follow the checklist step by step, and you'll have a clean, secure public repository!
