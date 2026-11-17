// /api/stare: ce token Blob ar folosi site-ul și dacă are baza Neon (TRANSFER.md, README „Mutarea imaginilor în Blob-ul vostru”).
// Cât timp există DWF_BLOB_TOKEN, imaginile se citesc încă din Blob-ul DWF; după ce noul proprietar îl șterge și republică,
// trebuie să arate "blob":"BLOB_READ_WRITE_TOKEN". Nu afișează niciun token.
export const DWF_BLOB_STORE = 'WwT5EJmKwqlgjsN3'; // purapa-brain, echipa DWF (dwf3)
export const storeId = token => token?.split('_')[3] ?? '';

export function stareBlob(env = process.env) {
  const dwf = env.DWF_BLOB_TOKEN?.trim();
  const own = env.BLOB_READ_WRITE_TOKEN?.trim();
  let blob = null;
  if (dwf) blob = 'DWF_BLOB_TOKEN';
  else if (own) blob = storeId(own) === DWF_BLOB_STORE ? 'BLOB_READ_WRITE_TOKEN (încă depozitul DWF)' : 'BLOB_READ_WRITE_TOKEN';
  return {blob, neon: Boolean(env.DATABASE_URL)};
}
