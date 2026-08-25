# LY Space Cloudflare R2 media worker

This Worker receives a local reference file from LY Space, verifies an upload token, writes it to your R2 bucket, and returns its public HTTPS URL. The desktop app never receives an R2 access key.

## Deploy

1. In Cloudflare R2, create a Standard bucket and connect a custom HTTPS domain for long-term use. The `r2.dev` address is suitable only for testing because Cloudflare rate-limits it.
2. Replace `bucket_name` and `PUBLIC_BASE_URL` in `wrangler.jsonc`. `PUBLIC_BASE_URL` must be the public R2 custom domain without a trailing slash.
3. From this folder, run `npm install`, then `npx wrangler login`.
4. Create a long random upload token and run `npx wrangler secret put UPLOAD_TOKEN`.
5. Run `npm run deploy`. Copy the displayed Worker URL, without `/upload`.
6. In LY Space settings, choose `Cloudflare R2 + Worker`, then enter the Worker URL, the same upload token, and the R2 public domain.

The Worker allows image, video, and audio uploads up to 100MB, matching the Cloudflare Free/Pro request-body limit. The bucket is public read-only so Agnes can fetch submitted references; the Worker write endpoint remains protected by `UPLOAD_TOKEN`. Rotate the secret and update LY Space if it is exposed.

For automatic cleanup, add an R2 lifecycle rule to remove the `ly-space/references/` prefix after the retention period you choose.
