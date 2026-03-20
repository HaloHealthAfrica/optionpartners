# Generated Secrets for optionpartners

## WEBHOOK_SECRET ✅ Set

A secure 64-character hex key was generated and set on Fly.io:

```
c7e71fc490544b015aaf7255db92f04e13265c890ce2348cbfeb1befc5368eaa
```

**Status:** Deployed to optionpartners.

**Note:** You had `EBHOOK_SECRET` (typo). The correct `WEBHOOK_SECRET` is now set. You can remove the typo:
```bash
fly secrets unset EBHOOK_SECRET -a optionpartners
```

---

## SIM_DEFAULT_USER_ID — You Must Set

This must be a **valid UUID of an existing user** in your database. It cannot be generated.

### Get your user ID

**Option A: Via database (if you have access)**
```sql
SELECT id FROM users ORDER BY created_at ASC LIMIT 1;
```

**Option B: Via Fly SSH (after deploying the script)**
```bash
fly ssh console -a optionpartners -C "node /app/backend/scripts/get-first-user-id.js"
```

**Option C: From the app**
- Log in → Settings → Profile (user ID may be in URL or API response)

### Set the secret

```bash
fly secrets set SIM_DEFAULT_USER_ID=<paste-your-uuid-here> -a optionpartners
```

Example:
```bash
fly secrets set SIM_DEFAULT_USER_ID=a1b2c3d4-e5f6-7890-abcd-ef1234567890 -a optionpartners
```

---

## Summary

| Secret | Status | Action |
|--------|--------|--------|
| WEBHOOK_SECRET | ✅ Set | None |
| SIM_DEFAULT_USER_ID | ❌ Pending | Run command above with your user UUID |
| EBHOOK_SECRET (typo) | Optional cleanup | `fly secrets unset EBHOOK_SECRET -a optionpartners` |
