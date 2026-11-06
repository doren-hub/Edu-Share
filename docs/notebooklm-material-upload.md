# NotebookLM material upload protocol

Slide and video direct uploads use `POST /api/tests/:id/material/{slide|video}/commit`:

1. Send `{ "action": "prepare", "size": <bytes> }`. Authentication and ownership
   are required. The server returns a unique staging `path` and `uploadUrl`.
   The PUT signature binds Content-Length to the declared size (45 MiB PDF,
   200 MiB MP4 maximum). Browser fetch supplies Content-Length from the File body.
2. PUT the file to `uploadUrl` with the appropriate Content-Type.
3. Send `{ "action": "commit", "path": <returned path> }`. Missing paths and
   paths outside this owner's/test's/material's staging namespace are rejected.

The server validates object size and Content-Type, and rejects slide files with
an identical size to the original PDF (the existing heuristic). It copies the
validated ETag conditionally to a fresh, immutable key without a PUT URL, then
publishes that key using a compare-and-swap DB update. This protects committed
material from reused PUT URLs and concurrent commits. The previously referenced
object is deleted only after publication. Individual material deletion also
clears its DB reference before cleaning up the referenced immutable object.

Rejected staging files are deleted. Storage cleanup is best effort: storage
outages, uploads abandoned before commit, and a repeated PUT after cleanup can
leave unreferenced staging files. A DB transport error retains the immutable
copy because the write may have succeeded; deleting that copy could break a live
reference. These cases require separate orphan cleanup; this change introduces
no bucket-wide deletion or production migration. The multipart POST endpoints also stream to a fresh immutable key, validate the
file extension/MIME and enforce their size limits, then compare-and-swap the
reference using both its previous value and owner. They do not need a staging
copy because no client PUT URL is issued. Failed uploads and definite conflicts
clean up only their new key. DB errors retain the possibly published key, just
as direct commits do. Only successful publication removes the prior reference
(including immutable keys), the old fixed key and legacy key; the original paper
PDF is excluded from cleanup. Cleanup failures leave orphan files and still
return success, with no rollback or bucket-wide sweep. Multipart keeps its
existing extension/MIME validation; it does not inspect file signatures.

All automated tests mock storage and Supabase. Do not validate by connecting to
production Supabase/R2 or running the paper pipeline.
