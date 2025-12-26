# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of SmartBin AI seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### Please DO NOT:

- Open a public GitHub issue for security vulnerabilities
- Post security vulnerabilities in discussions or comments

### Please DO:

1. **Use GitHub Security Advisories** (Preferred)
   - Go to the [Security tab](https://github.com/birchcoin/smartbin_ai_ha/security)
   - Click "Report a vulnerability"
   - Fill in the details

2. **Or open a private issue**
   - Create an issue with `[SECURITY]` prefix
   - Provide detailed information about the vulnerability

### What to Include

When reporting a vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)
- Your contact information (if you want to be credited)

### What to Expect

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Fix Timeline**: Depends on severity
  - Critical: Within 7 days
  - High: Within 30 days
  - Medium: Within 90 days
  - Low: Next regular release

### Disclosure Policy

- We will acknowledge your report within 48 hours
- We will provide a more detailed response within 7 days
- We will work with you to understand and resolve the issue
- We will keep you informed of our progress
- Once the issue is resolved, we will publish a security advisory
- We will credit you in the advisory (unless you prefer to remain anonymous)

## Security Best Practices for Users

### API Key Security

- **Never** commit your Z.AI API key to version control
- **Never** share your API key publicly
- Use environment variables or Home Assistant's config flow
- Rotate keys if you suspect they've been exposed
- Monitor your Z.AI API usage for unusual activity

### Home Assistant Security

- Keep Home Assistant updated to the latest version
- Keep this integration updated to the latest version
- Use strong authentication for Home Assistant
- Enable SSL/TLS for remote access
- Regularly review Home Assistant access logs
- Use network segmentation for IoT devices

### NFC Tag Security

- NFC tags should only trigger authorized upload actions
- Monitor the upload logs for unusual activity
- Place bins in secure locations if they contain sensitive items
- Use the authentication token system (automatically handled)

### Data Privacy

- Images uploaded to bins are processed by Z.AI API
- Review Z.AI's privacy policy at https://z.ai
- Images are stored locally in `/config/www/bins/`
- Regularly clean up old images if needed
- Consider network isolation for sensitive environments

## Known Security Considerations

### Upload Token System

The integration uses a short-lived token system for uploads:
- Tokens expire after 5 minutes (300 seconds)
- Tokens are single-use
- Tokens are bound to specific bin IDs
- Tokens are cryptographically secure (using `secrets.token_urlsafe(32)`)

### API Communication

- All API calls to Z.AI use HTTPS
- API keys are sent via Authorization header
- API responses are validated before processing
- Rate limiting is handled by Z.AI API

### Image Storage

- Images are stored in `/config/www/bins/` directory
- This directory is accessible via Home Assistant web interface
- Consider Home Assistant authentication and access controls
- Images may contain sensitive information - review regularly

## Security Audit

This project has undergone security auditing. See `SECURITY_AUDIT.md` for details.

### Audit Summary

- ✅ No hardcoded credentials
- ✅ Secure token generation
- ✅ Proper input validation
- ✅ No SQL injection vulnerabilities
- ✅ No command injection vulnerabilities
- ✅ Dependencies are regularly updated

## Security Updates

Security updates will be released as:
1. Patch versions (e.g., 1.0.1) for minor fixes
2. Minor versions (e.g., 1.1.0) for moderate changes
3. Major versions (e.g., 2.0.0) for breaking changes

Subscribe to this repository's releases to get notified of security updates.

## Attribution

We appreciate the security research community and will credit researchers who responsibly disclose vulnerabilities (unless they prefer to remain anonymous).

## Questions?

If you have questions about this security policy, please open a general issue (not for vulnerabilities) or start a discussion.

---

Last updated: 2025-12-26
