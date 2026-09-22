// Una sola vez: vacía el bucket del rastro de CloudTrail (todas las versiones
// y marcadores) saltando la retención GOVERNANCE, para que Terraform pueda
// eliminar el bucket. El trail ya no existe: nada vuelve a escribir aquí.
//
//   node scripts/vaciar-audit-trail.mjs
//   terraform -chdir=infra/platform apply
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const Bucket = process.argv[2] ?? 'medical-consent-audit-trail-781485980004';
const s3 = new S3Client({ region: 'us-east-1' });

let KeyMarker;
let VersionIdMarker;
let deleted = 0;
for (;;) {
  const page = await s3.send(new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker, MaxKeys: 1000 }));
  const objs = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
  if (objs.length) {
    const r = await s3.send(new DeleteObjectsCommand({
      Bucket,
      BypassGovernanceRetention: true,
      Delete: { Objects: objs, Quiet: true },
    }));
    if (r.Errors?.length) {
      console.error(r.Errors[0]);
      process.exit(1);
    }
    deleted += objs.length;
    process.stdout.write(`\r${deleted} versiones borradas`);
  }
  if (!page.IsTruncated) break;
  KeyMarker = page.NextKeyMarker;
  VersionIdMarker = page.NextVersionIdMarker;
}
console.log(`\nlisto: ${Bucket} vacío`);
