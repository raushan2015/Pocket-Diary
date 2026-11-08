# Alert: AttachmentUploadFailed

**Severity:** Warning
**Source:** Upload endpoint 5xx/413/415 / User reports "Upload failed" / Attachment table missing entries
**Runbook:** This file

## Symptoms
- Users cannot attach images/files
- Errors: 413 (Payload Too Large), 415 (Unsupported Media Type), 500
- Attachment files not appearing in `/app/data/attachments/`
- Mobile upload retry loops

## Diagnosis Steps

1. **Check upload logs**
   ```bash
   docker compose logs memo-manager --since=30m | grep -i attach
   # Look for: "fileSize limit", "magic bytes", "mime type", "ENOSPC"
   ```

2. **Check file size limits**
   - Server: `fastifyMultipart` limit 5MB (configurable)
   - Nginx/proxy: `client_max_body_size` (if used)
   - Mobile: chunks large files?

3. **Check allowed types**
   ```bash
   # Server validates magic bytes: JPEG, PNG, WebP, GIF, PDF, TXT, MD
   # Check attachment.service.ts for current allow-list
   ```

4. **Check disk space & permissions**
   ```bash
   df -h /app/data
   ls -ld /app/data/attachments
   # node:node ownership? writable?
   ```

5. **Check for orphaned DB rows**
   ```bash
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db \
     "SELECT a.id, a.fileName, a.storagePath FROM attachments a LEFT JOIN memos m ON m.id=a.memoId WHERE m.id IS NULL;"
   ```

## Mitigation

| Error | Action |
|-------|--------|
| 413 Too Large | Increase `fastifyMultipart` limit; warn users |
| 415 Unsupported | Verify file type; allow-list in `attachment.service.ts` |
| 500 Magic bytes | File corrupted or mislabeled; reject gracefully |
| ENOSPC | See [DiskSpaceCritical](./disk-space-critical.md) |
| Permission | `chown -R node:node /app/data/attachments` |

## Resolution

| Root Cause | Fix |
|------------|-----|
| Config too restrictive | Adjust limits; document max sizes |
| MIME detection bug | Fix `file-type` validation; add tests |
| Storage path bug | Fix `ATTACHMENTS_DIR` config (must be inside data volume) |
| Cleanup orphaned | Cron job: delete attachment rows without memo + files |

## Escalation

- **< 30 min**: On-call checks logs; adjusts limits if config issue
- **< 2 hours**: If code bug, deploy fix
- **< 24 hours**: Post-mortem; improve validation UX

## Post-Incident

- [ ] Add upload success/failure metrics
- [ ] Test with edge cases: 5MB exactly, corrupt files, weird MIME
- [ ] Document supported types + sizes in user guide
- [ ] Implement client-side validation (preview before upload)