# Security policy

Computer MCP gives an AI remote control of your computers. Treat its secrets
accordingly.

## What the secrets protect

- The MCP link (`https://<host>/mcp`, or `https://<host>/t/<secret>/mcp`) and the
  admin key are the keys to every connected computer: shell, files, desktop
  control and secret filling. Anyone holding them can control your computers.
- Scoped client tokens (`cmcp_...`) are limited to the tools you selected for
  that key; the admin key is never limited.
- Saved account passwords in the phone app's vault never leave the phone
  except as typed keystrokes on the computer, and the AI never sees them.

## If a secret leaks

1. Replace it at once: `computer-mcp rotate` (the old link stops working
   immediately), or delete the client token in the phone app.
2. Update every AI client with the new link.
3. Check `computer-mcp memory` and recent activity for anything unfamiliar.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Report it
privately through the GitHub repository's **Security Advisories**
(Security tab → Report a vulnerability). Include the version, what you did,
and what you expected. We will confirm receipt, fix it, and credit you in
the release notes if you want.

## Supported versions

Only the latest release (currently 0.6.x) receives security fixes.
