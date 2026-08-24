# TOILE — instructions de travail (CLAUDE.md)

TOILE est un « CLO3D du navigateur » : patron 2D → drapé physique XPBD WebGPU
sur un corps 3D, orienté grand public (blocs composables, sur-mesure, pont
production). Stack : TypeScript + Vite, moteur maison (`src/engine/`), app
(`src/main.ts`, `src/app/`). Serveur : `npm run dev` → http://localhost:5173.
Référence produit : `docs/COMPARATIF-FINAL-CLO-TOILE.md` (rétro-ingénierie
CLO ↔ TOILE du 23/08/2026, verdict et chantiers restants).

## Méthode de travail (règles dures, exigées par Jessy)

- **UNE modification à la fois**, mesurée avant/après, validée dans le
  navigateur, PRÉSENTÉE — et committée **seulement** quand Jessy écrit
  « committe ». Jamais de commit spontané.
- **Mesurer avant de coder** : instrumenter d'abord (hooks ci-dessous), poser
  des chiffres, faire des expériences de contrôle A/B. Les analyses
  superficielles ne passent pas.
- Une amélioration invisible pour l'utilisateur n'en est pas une : valider à
  l'écran (captures), pas seulement aux métriques.
- Ce qui échoue se reverte proprement et s'écrit honnêtement.

## Git (sur ce Mac)

- Message : `vNNN — description en français` (v255 = dernier en date).
  Trailers utilisés dans l'historique :
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` + `Claude-Session: <url>`.
- **JAMAIS `git add -A`** : stager fichier par fichier. Ne jamais stager
  `.env.local` (contient ANTHROPIC_API_KEY — ne jamais l'afficher non plus),
  ni le diff préexistant de `package.json`, ni `_to_delete/`,
  ni `relance-toile.command`.
- Pièges connus : des locks `.git/index.lock` / `.git/HEAD.lock` traînent —
  les `mv` vers `_to_delete/` avant/après les opérations (`rm` peut être
  indisponible selon l'outil). `git status` LAISSE un lock : préférer
  `git diff --name-only`. Les messages « unable to unlink » sur commit/add
  sont bénins (l'opération réussit). `git checkout -- fichier` peut échouer :
  utiliser `git show HEAD:chemin > chemin`.
- Vérité TypeScript : `npx tsc --noEmit` doit sortir à 0 avant tout commit.

## Validation navigateur (localhost:5173)

Flux tee : bouton « 👕 T-shirt » → aperçu pose CLO (galbe torse, manches en
tubes sur les bras, col en anneau) → « ▶ Essayer en 3D » (~7 s porté, 30 fps).
Corps : Femme/Homme (scans mia/leo) ; poses T / Bras 45° / Debout (collisions
cuites par pose, scans uniquement). Hooks dev (console) :

- `__toileSeamAudit(seuil_mm)` — résidus de couture par famille et par paire
  de pièces (le juge de paix du moteur ; tee sain = 0 ouvert, 0,0 mm).
- `__toilePastilles(filtre)` — positions des points d'arrangement courants.
- `__toileArrangePiece(pid, 'pastille-id')` — range/enroule une pièce
  (pastilles bras/cou = enroulement ; ids précis : `arm-r-front-2`, etc.).
- `__toileAnatomical(bool)`, `__toileRotatePiece`, `__toileCollisionAudit()`,
  `__toileStress()`, `__toilePattern` (vue patron).
- Piège : pas de boucles JS lourdes injectées (thrash) ; les toasts/étiquettes
  2D sont sur canvas (vérifier par capture, pas par innerText).

## État au 23/08/2026 (v255)

- **Public-ready (périmètre de test)** : tee composable (blocs manches /
  encolure / col / longueur + aisance), sur-mesure live (regrade au curseur,
  design préservé), carte d'ajustement 1 clic + légende, matières + imprimés,
  pont production complet (fiche JSON, plans de découpe mono et multi-tailles
  avec crans légendés, DXF mono + gradé 6 tailles, glTF, bilan matière CSV
  avec quantités et matelas mélangé). Robe et jupe propres aussi.
- **Points d'arrangement façon CLO** : ~46 pastilles générées sur des volumes
  (torse = ellipses interpolées entre niveaux mesurés ; bras = axe mesuré
  `m.arm.path`), qui **suivent la pose** (mesure du corps posé dédiée à
  l'arrangement ; le regradage reste sur le corps natif T — v189). Les manches
  s'enroulent sur les bras posés à l'aperçu ET à l'essayage (A/B validé).
- **Hoodie retiré du catalogue public** (bouton masqué, brief neutralisé) :
  banc de crash-test moteur, jonctions d'épaule encore ouvertes.
- Chantiers restants (voir comparatif §7) : soudure/robustesse couture
  multi-pièces (§18.2 — hoodie), matelassage doudoune + poche pantalon
  (§18.3 suite), calibration de la carte d'ajustement (rouge trop généreux),
  auto-sauvegarde de session, offset réglable par pastille, artefact connu :
  fente de crête d'épaule du tee en **T-pose uniquement** (coutures à 0 mm,
  topologie fermée — profondeur de rendu ; dossier de faits dans l'historique
  de commits v254-v255 ; tests conseillés en Bras 45°).

## Approche produit

Copier CLO en l'améliorant, sur DEUX étages (décision Jessy, 24/08/2026) :

1. **Grand public (le défaut)** : zéro traçage, zéro couture manuelle, zéro
   réglage physique exposé — blocs + matières + sur-mesure + « Essayer en
   3D » + dossier d'usine.
2. **Pro / modélisation manuelle (à CONSERVER et développer)** : l'atelier
   complet — traçage à la plume, courbes, pinces, coutures manuelles (🪡),
   placement 3D — existe déjà (v96-v135) et doit monter vers le niveau CLO :
   éditeur fin des points d'arrangement (offset par pièce), propriétés de
   couture (sens, pli), saisie au mm, M:N/embu, marge de couture par bord.

Référence pour copier CLO : `docs/clo-arrangement-extrait/` (109 points,
19 volumes, mapping pièce→point + 15 coutures du tee, extraits en clair).
Quand un comportement CLO fait référence, l'observer réellement (CLO est
installé sur ce Mac) plutôt que le supposer.
