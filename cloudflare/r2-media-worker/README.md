# LY Space Cloudflare R2 media worker

This Worker receives a local reference file from LY Space, verifies an upload token, writes it to your R2 bucket, and returns its public HTTPS URL. The desktop app never receives an R2 access key.

## Deploy

1. In Cloudflare R2, create a Standard bucket. Do not expose the bucket with `r2.dev` or R2 Public Access: this Worker reads uploaded objects over HTTPS itself.
2. Replace `bucket_name` and `PUBLIC_BASE_URL` in `wrangler.jsonc`. `PUBLIC_BASE_URL` must be this Worker URL or a custom Worker HTTPS domain, without a trailing slash.
3. From this folder, run `npm install`, then `npx wrangler login`.
4. Create a long random upload token and run `npx wrangler secret put UPLOAD_TOKEN`.
5. Run `npm run deploy`. Copy the displayed Worker URL, without `/upload`.
6. In LY Space settings, choose `Cloudflare R2 + Worker`, then enter the Worker URL, the same upload token, and the Worker public HTTPS URL. The app sends `POST /upload` as `multipart/form-data` with a `file` field; do not add the multipart `Content-Type` boundary manually.

The Worker allows image, video, and audio uploads up to 100MB, matching the Cloudflare Free/Pro request-body limit. It returns `{ ok, success, key, url, publicUrl }`; `url` and `publicUrl` are HTTPS routes served by the Worker, while the write endpoint remains protected by `UPLOAD_TOKEN`. Rotate the secret and update LY Space if it is exposed.

For automatic cleanup, add an R2 lifecycle rule to remove the `ly-space/references/` prefix after the retention period you choose.
