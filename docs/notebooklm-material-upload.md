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
no bucket-wide deletion or production migration. The legacy multipart POST
endpoints retain their existing upload behavior.

All automated tests mock storage and Supabase. Do not validate by connecting to
production Supabase/R2 or running the paper pipeline.
