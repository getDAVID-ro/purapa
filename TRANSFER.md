# Transferul Purapa către getDAVID

> Pregătit pe 17.11.2026, după modelul boxe-depozitare.ro. Repo-ul trece prin transferul de pe GitHub, în organizația `getDAVID-ro`. Proiectul Vercel trece printr-un link de claim, care mută odată cu el și baza Neon. Fișierele din Vercel Blob nu se mută: noul proprietar își face Blob-ul lui și copiază imaginile cu `npm run blob:copy`, apoi DWF îl șterge pe al lui.

## Ce există acum, la DWF

| Resursă | Unde | Detalii |
|---|---|---|
| Repo | GitHub `getDAVID-ro/purapa` (mutat din `toma776/purapa`) | ramura de producție `main`; GitHub redirecționează adresa veche |
| Proiect Vercel | echipa `dwf3`, proiectul `purapa` (`prj_hS6SwlZjFr6ktpB2CtzsbkMxrcdm`) | producție: https://purapa-six.vercel.app; legat de GitHub (`main` publică singur) |
| Baza de date | Neon `purapa-db`, prin Vercel Marketplace (`store_8sDxAsWbylXzmpVm`) | Frankfurt, planul Free; variabilele `DATABASE_URL`, `POSTGRES_*`, `PG*`, `NEON_*` pe toate mediile. Ține baza panoului (`purapa.db`, un rând cu versiune) și lista imaginilor (`brain_media`) |
| Fișiere | Vercel Blob `purapa-brain` (`store_WwT5EJmKwqlgjsN3`) | Frankfurt, privat; variabila `BLOB_READ_WRITE_TOKEN`. Blocat de cota Hobby până pe ~27.11.2026. Conține doar o copie veche a bazei, fără imagini |
| Copia tokenului Blob | variabila `DWF_BLOB_TOKEN`, pe toate mediile | același token ca `BLOB_READ_WRITE_TOKEN`, sub alt nume. Rămâne în proiect după ce noul proprietar șterge `BLOB_READ_WRITE_TOKEN`, ca `npm run blob:copy` să poată citi din Blob-ul DWF |

**Imaginile** sunt în git (`public/media`), deci `npm run blob:copy` le ia de acolo. Din Blob-ul DWF copiază doar ce lipsește din git, dacă răspunde.

**De ce contează Blob la transfer.** Vercel copiază variabilele de mediu odată cu proiectul, dar nu și store-ul Blob. După transfer, `BLOB_READ_WRITE_TOKEN` arată încă spre Blob-ul DWF. De aceea ordinea e:
1. transferul;
2. copierea la noul proprietar;
3. confirmarea lui;
4. abia apoi ștergerea la DWF.

## Ordinea transferului

### Înainte (o dată)

DWF își păstrează o copie a credențialelor vechi:
```bash
npx vercel env pull .env.transfer-dwf --environment=production --yes
```
Fișierul e ignorat de git (`.env*`) și nu se trimite pe email.

### Transferul (DWF)

1. **GitHub:** repo-ul e deja în `getDAVID-ro/purapa`. Local, `git remote set-url origin https://github.com/getDAVID-ro/purapa.git`.
2. **Vercel, cu link de claim.** Linkul e valabil 24 de ore, iar cine îl are poate lua proiectul, deci îl trimiteți doar noului proprietar. Codul se generează din rădăcina repo-ului:
   ```bash
   npx vercel api /v1/projects/purapa/transfer-request?teamId=team_qqACD63OhjkuSJknspI9l6iQ -X POST --input - <<< '{}'
   ```
   Linkul:
   ```
   https://vercel.com/claim-deployment?code=<code>&returnUrl=https%3A%2F%2Fpurapa-six.vercel.app
   ```
   - Noul proprietar îl deschide, intră în contul lui Vercel, alege echipa (de exemplu `get-david`) și apasă **Transfer**.
   - Odată cu proiectul se mută și baza Neon `purapa-db`, cu variabilele de mediu.
   - Dacă linkul expiră, generați altul cu aceeași comandă.
   - **Varianta fără link:** Settings → General → **Transfer Project**. Atunci Neon rămâne la DWF și noul proprietar rulează `npm run transfer:setup`, descris mai jos.
3. **Domeniul:** proiectul are doar adrese `*.vercel.app`. Dacă între timp s-a adăugat purapa.ro în echipa DWF, se mută și el (Domains → ⋯ → **Move**).

### Mesajul pentru noul proprietar (gata de trimis)

Linkul de claim se trimite separat, înainte:

> 1. În proiectul de pe Vercel: Storage → Create → Blob, public, Frankfurt, legat de proiect. Dacă proiectul are deja variabila `BLOB_READ_WRITE_TOKEN`, ștergeți-o întâi: e de la depozitul DWF.
> 2. Cu Node 24 sau mai nou: `git clone https://github.com/getDAVID-ro/purapa.git`, apoi `cd purapa`, apoi `npm install`, apoi `npx vercel link` (alegeți proiectul `purapa`), apoi `npx vercel env pull .env.local`, apoi `npm run blob:copy`. Copierea durează un minut și la final confirmă fiecare fișier.
> 3. În Settings → Environment Variables ștergeți `DWF_BLOB_TOKEN`, apoi faceți Redeploy.
> 4. Rulați încă o dată `npm run blob:copy`, ca să prindă ce s-a încărcat între timp.
>
> Verificare: https://purapa-six.vercel.app/api/stare trebuie să arate `"blob":"BLOB_READ_WRITE_TOKEN"` și `"neon":true`. Pașii sunt și în README, la „Mutarea imaginilor în Blob-ul vostru”.

**Ce arată `/api/stare`** (`src/core/stare.mjs`): ce token Blob ar folosi site-ul. Nu afișează niciun token.
- `DWF_BLOB_TOKEN`: cât timp copia veche e în proiect.
- `BLOB_READ_WRITE_TOKEN`: după ce noul proprietar o șterge și republică.
- `BLOB_READ_WRITE_TOKEN (încă depozitul DWF)`: dacă n-a creat încă Blob-ul lui.
- `neon`: dacă proiectul are `DATABASE_URL`.

După transfer, Settings → Git din proiect trebuie să arate `getDAVID-ro/purapa`, ramura `main`. Dacă nu, se leagă cu Connect Git Repository.

### Varianta fără link de claim: `npm run transfer:setup`

Neon rămâne atunci în echipa DWF.

**La DWF:**
1. `npm run transfer:pack` urcă ultima variantă a bazei și scrie în `data/transfer-mesaj.txt` mesajul pentru Claude Code-ul noului proprietar, cu cheia de citire a bazei vechi.
2. Înainte de transfer, deconectați resursele DWF de proiect:
   ```bash
   npx vercel integration resource disconnect purapa-db purapa
   ```
   Blob-ul se deconectează din Storage → store → Projects → Disconnect.

**La noul proprietar:** `npm run transfer:setup -- --from-db "<url>"`. Comanda:
- creează în echipa lui Neon `purapa-db` și Blob-ul public `purapa-media`, cerând întâi acordul pentru termenii Neon;
- copiază baza și imaginile;
- republică proiectul și verifică.

### După confirmarea noului proprietar (DWF)

```bash
npx vercel blob delete-store store_WwT5EJmKwqlgjsN3
```
- Dacă Blob refuză ștergerea pentru că store-ul e încă legat de proiect: Storage → `purapa-brain` → Projects → Disconnect, apoi din nou comanda.
- **Neon:** dacă s-a mutat cu linkul de claim, nu mai apare în `npx vercel integration list --all`. Dacă a rămas în `dwf3`: `npx vercel integration resource delete purapa-db --disconnect-all`.
- **Copiile locale:** DWF șterge `.env.transfer-dwf`, `.env.local` și `data/transfer-mesaj.txt`, care au credențialele vechi.

## Bine de știut

- **Planul gratuit Neon:** baza adoarme după câteva minute fără cereri. Panoul online o verifică cel mult o dată la 30 de secunde, iar serverul local o dată la 15 minute.
- **Cota Blob (Hobby):** 10.000 de operații simple și 2.000 avansate pe lună, iar peste ea store-ul e blocat 30 de zile. De aceea Blob-ul ține doar imagini, se scrie doar când apare o imagine nouă și nu e listat decât de `blob:copy`.
- **Lansarea pe purapa.ro:** Hobby nu permite uz comercial, deci e nevoie de Pro, plus pașii din README („În ziua lansării”).
