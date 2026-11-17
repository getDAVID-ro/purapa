# Transferul proiectului Purapa

Cum trece proiectul de la DWF la noul proprietar: repo-ul GitHub, proiectul Vercel și datele.

**Ce se mută și cum:**
- **Codul și site-ul public** sunt în git (`public/`). Merg odată cu repo-ul.
- **Baza panoului** (`purapa.db`) stă în **Neon**, iar **imaginile** (`data/media`) stau în **Vercel Blob**. Resursele astea aparțin echipei Vercel, nu proiectului, deci nu se mută odată cu el. Noul proprietar își creează propriul Neon și propriul Blob cu o singură comandă (`npm run transfer:setup`). Comanda copiază datele din resursele noastre, după care noi le ștergem.

## La noi (DWF)

1. **Ultima variantă a datelor.** Oprește `npm start`, apoi rulează:
   ```bash
   npm run transfer:pack
   ```
   Comanda urcă baza în Neon și imaginile lipsă în Blob. Apoi scrie în `data/transfer-mesaj.txt` mesajul pentru noul proprietar.
   - Fișierul conține cheile de acces la Neon-ul și la Blob-ul nostru. Nu intră în git; trimite-l doar pe un canal privat.

2. **GitHub.** Repo-ul `toma776/purapa` se transferă din Settings → General → Danger Zone → Transfer ownership, către contul noului proprietar.

3. **Deconectează resursele noastre de proiect.** Altfel, cheile lor ar pleca odată cu proiectul. Datele rămân în resurse; după acest pas, panoul online e oprit până termină noul proprietar.
   ```bash
   npx vercel integration resource disconnect purapa-db purapa
   ```
   ```bash
   npx vercel blob list-stores
   ```
   Deconectează din dashboard (Storage → store → Projects → Disconnect) fiecare store Blob afișat.

4. **Proiectul Vercel.** Proiectul `purapa` se transferă din Settings → General → Transfer Project, către echipa noului proprietar. Variabilele obișnuite, ca `MANAGE_OPEN`, merg odată cu proiectul.

5. **Trimite mesajul** din `data/transfer-mesaj.txt`.

6. **După ce noul proprietar confirmă că totul merge**, șterge resursele noastre. Ștergerea e definitivă.
   ```bash
   npx vercel integration resource delete purapa-db
   ```
   ```bash
   npx vercel blob delete-store <id-ul store-ului>
   ```

## La noul proprietar

Totul se face din Claude Code, pornind de la mesajul primit. Pe scurt:

1. Clonează repo-ul, apoi rulează `npm install`. E nevoie de Node 24 sau mai nou.
2. Rulează `npx vercel login`, apoi `npx vercel link` pe proiectul `purapa` din echipa ta. Dacă Vercel nu mai e legat de repo după transfer: `npx vercel git connect`.
3. Rulează comanda din mesaj:
   ```bash
   npm run transfer:setup -- --from-db "<cheia veche Neon>" --from-blob "<cheia veche Blob>"
   ```
   - **Prima rulare** se oprește și cere acordul pentru termenii Neon (planul gratuit). Claude te întreabă, iar după „da” reia comanda cu `--accept-neon-terms`.
   - **Comanda creează** în echipa ta:
     - baza Neon `purapa-db` (Frankfurt);
     - Blob-ul privat `purapa-media`.
   - **Apoi** aduce cheile în `.env.local`, copiază baza și imaginile, republică proiectul și verifică `/manage/`.
   - **Imaginile:** dacă Blob-ul vechi nu răspunde, se iau din `public/media` (din git).
4. Pornește local cu `npm start`. Site-ul și panoul sunt la http://localhost:3100. Orice schimbare de conținut se publică singură pe GitHub-ul tău și pe Vercel.

Pe alt calculator, cu proiectul deja preluat, ajunge `npm run setup`. Comanda aduce baza din Neon și imaginile din Blob.

## Bine de știut

- **Planul gratuit Neon:** baza adoarme după câteva minute fără cereri. Panoul online o verifică cel mult o dată la 30 de secunde, iar serverul local o dată la 15 minute, deci rămâne în limitele planului gratuit.
- **Cota Blob (Hobby):** 10.000 de operații simple și 2.000 avansate pe lună, iar peste ea store-ul e blocat 30 de zile. De aceea Blob-ul ține doar imagini și se scrie doar când apare o imagine nouă. Nu adăuga verificări dese spre Blob.
- **Planul Vercel:** Hobby nu permite uz comercial. Pentru lansarea pe purapa.ro e nevoie de Pro, plus pașii din README („În ziua lansării”).
