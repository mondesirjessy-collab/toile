# COMPARATIF FINAL — CLO 3D ↔ TOILE

*Rétro-ingénierie croisée menée en direct le 23/08/2026 : CLO Standalone 2026.1 (r58419) piloté sur ton Mac (avatar MV2.1_Leo, tee modulaire Dropped Sleeve composé, drapé, inspecté) ↔ TOILE v253 (`525b058`) testé sur localhost:5173 (parcours complets + balayage moteur 7 vêtements, Homme bras 45°). Complète et actualise le BLUEPRINT-CLO du 18/08 — même structure de piliers. Objectif : mesurer si la base TOILE est prête pour tes phases de test grand public.*

---

## 0. Verdict en une phrase

**Sur son périmètre grand public (t-shirt composable + sur-mesure + pont production), TOILE fait aujourd'hui ce que CLO fait — en moins de gestes, sans installation, et avec des capacités que CLO n'a pas ; le moteur reste inégal sur les vêtements complexes (hoodie, doudoune), et c'est la seule vraie frontière avant d'élargir le test public au-delà du tee.**

---

## 1. Ce qui a été mesuré (méthode)

Côté CLO, en direct : parcours bibliothèque modulaire complet (Men → Basic Shirts → Dropped Sleeve, 4 blocs composés, coutures auto, simulation), inspection des propriétés (tissu, couture, pièce, résolution), éditeur d'avatar (6 onglets, dont l'éditeur des volumes/points d'arrangement), rendu schématique, recherche de la carte de tension. Côté TOILE : les parcours miroir chronométrés (composition, essayage, carte d'ajustement, matière par pièce), puis le balayage moteur : 7 vêtements essayés dans les mêmes conditions (Homme, bras 45°, 13-20 s de pose). Les exports production ont été validés tout au long de la session (v237-v251) en capturant les vrais fichiers.

---

## 2. Tableau de synthèse — pilier par pilier

| Pilier | CLO 2026.1 (mesuré) | TOILE v253 (mesuré) | Verdict |
|---|---|---|---|
| **Composer un vêtement** | Bibliothèque modulaire : ~6 double-clics + espace ; blocs figés (2 devants, 2 dos, 2 manches, 3 cols) | 1 clic « T-shirt » (~2-3 s) ; blocs échangeables par sélecteurs (manches, encolure, col, longueur) + aisance continue | **Parité, TOILE plus court** ; CLO a plus de variantes de blocs, TOILE interpole |
| **Placement / arrangement** | Blocs arrivent pré-arrangés (galbés, hauteur de port) ; volumes+points éditables (X/Y/Compensation/Direction) | Pose CLO par défaut (galbe torse, tubes de manche, anneau de col, hauteur de port — répliqué de l'observation) ; 18 pastilles, enroulement au clic | **Parité visuelle** ; CLO garde l'éditeur fin des points (offset réglable), TOILE calcule des mensurations |
| **Coudre** | Coutures inter-blocs pré-câblées + atelier manuel complet (segment, libre, M:N, vérif longueur) | Coutures automatiques du composable + atelier manuel (🪡 coudre, couture libre, zip) | **Parité usage** ; l'atelier manuel CLO reste plus profond (M:N, embu contrôlé) |
| **Simuler / drapé** | ~6 s à convergence (sim bloquante) ; particules 20 mm ; A-pose nickel | ~7 s porté / ~15 s posé, **interactif 30 fps pendant la sim** (tirer le tissu) ; particules ~9-10 mm (plus fin) ; substeps auto | **Parité du résultat sur le tee, TOILE plus interactif** ; micro-jours d'épaule en T-pose côté TOILE |
| **Tissu / matières** | ~55 préréglages calibrés + coût/tissu + PBR 3 faces + CLOFAB | Préréglages physiques (mêmes familles XPBD) + par-pièce (couleur, grammage, physique) + imprimés upload | **CLO devant en catalogue et PBR** ; TOILE suffisant grand public, imprimés plus simples |
| **Fit / sur-mesure** | Éditeur d'avatar ~13 champs + formes ; gradation par points gradés ; carte tension documentée mais introuvable en 4 min de pilotage | 6 mensurations + 3 morphotypes + scans + import OBJ ; **regrade EN LIVE au curseur** (design préservé) + aisance ; carte d'ajustement **1 clic + légende** | **TOILE devant en usage grand public** ; CLO devant en finesse pro (13 champs, points gradés) |
| **Production** | Tech Pack JSON, BOM XML Pacx, DXF-AAMA, PDF, PLT, glTF/USD/FBX/Alembic/OBJ/VRM, coloris | Techpack JSON (métrage réel nesté), marker SVG mono + **multi-tailles étiqueté**, crans 2 familles + légende, **DXF gradé 6 tailles par calques**, glTF, **bilan matière CSV** (quantités, matelas mélangé, économie 9-11 %) | **Parité sur l'essentiel usine** ; CLO devant en largeur de formats (USD/FBX/PLT/BOM XML), TOILE devant sur le chiffrage de commande |
| **Rendu** | Photoréaliste + schématique 1 clic + rendu cloud | Temps réel MSAA 4×, wrap-lit ; pas de mode schématique 3D | **CLO devant** (PBR + flat) ; TOILE instantané |
| **Accès** | App macOS, licence, installation, connexion | **Navigateur, zéro installation** | **TOILE, structurellement** |
| **Écosystème** | CLO-SET cloud, marketplace, CLOFAB, plugins Python | Aucun (export/import JSON local) | **CLO** — c'est l'infra hors-navigateur assumée |

---

## 3. Les découvertes clés de la rétro-ingénierie du jour

**Le parcours modulaire CLO, décortiqué.** Double-cliquer un bloc l'ajoute DÉJÀ arrangé — devant galbé sur la poitrine à hauteur de port — et cousu aux blocs présents (coutures « Sewing_NNN » auto : force du pli 5, angle 180). CLO drape à l'ajout de chaque bloc ; espace pour converger (~6 s). C'est exactement le modèle que TOILE a répliqué en v252-v253 : la validation est faite dans les deux sens.

**Le modèle d'arrangement complet, vu dans l'éditeur.** Volumes d'encadrement nommés (Arm_L/R, Wrist, Body, Shoulder, Head…) attachés à deux articulations du squelette, avec forme et dimensions ; des dizaines de points (Arm_Back_1/2/3, Arm_Front_1/2 par côté…) paramétrés par **X, Y, Compensation (l'offset) et Direction d'enveloppement**. TOILE implémente le même modèle en réduit (18 pastilles calculées des mensurations, enroulement par rôle) — fonctionnellement équivalent pour le tee, sans l'éditeur fin.

**La carte de tension CLO est mal exposée.** Quatre minutes de pilotage réel (menus 3D/Tissu/contextuel, recherche « tension ») sans la trouver — même constat que le blueprint du 18/08. La carte d'ajustement TOILE est un bouton visible + légende (« Tension du tissu — Ample/Ajusté/Serré »). Sur ce point précis, l'outil « pour tous », c'est TOILE. (Réserve honnête : la calibration TOILE lit « serré » large sur le haut du torse — lisible mais sévère.)

**Chiffres de simulation.** CLO : particules 20 mm par défaut, résolutions Haute/Basse/perso, sim bloquante. TOILE : ~9-10 mm par défaut (plus fin), 32/64/128, 30 fps interactifs pendant la pose (sim 21,8 ms, substeps auto), on peut tirer le tissu pendant qu'il tombe. CLO affiche par pièce la longueur 2D vs 3D (~1 % d'étirement toléré au posé) — TOILE a l'équivalent via la carte de tension mais pas la lecture numérique par pièce.

---

## 4. La matrice moteur (le vrai état, mesuré le 23/08, Homme bras 45°)

| Vêtement | État à ~15-20 s | Verdict test public |
|---|---|---|
| **T-shirt composable** | Porté, propre (T-pose : micro-jours aux sommets d'épaule) | **OUI — le périmètre du test** |
| **Robe** | Portée, propre (même sur corps homme) | **OUI** |
| **Jupe** | Portée, propre | **OUI** |
| **Veste doublée** | Portée, devant fermé, doublure ok ; aisselle rugueuse | OUI avec réserve |
| **Pantalon** | Porté, tombé correct ; poche/hanche entrouverte, latérale visible | Réserve (démo ok, finitions non) |
| **Hoodie** | ÉNORME progrès vs crash-test du blueprint (avant : déchiré, pièces au sol → maintenant : porté, capuche, poche, manches) ; jonctions d'épaule entrouvertes, fils étirés vers le sol | **NON — beta interne** |
| **Doudoune** | Portée ; canaux de matelassage déchirés sur les flancs | **NON — beta interne** |

Lecture honnête : 4/7 propres ou quasi, 3/7 avec défauts nets. La cause racine des 3 est connue et documentée (blueprint §18.2-18.3, non traités : couture à convergence, soudure des coutures fermées, bouchage par tag d'ouverture). Le §18.1 (pré-assemblage), lui, est fait — c'est ce qui a transformé le hoodie.

---

## 5. Ce que TOILE a que CLO n'a pas (mesuré, pas marketing)

Le sur-mesure consumer en live (bouge un curseur de mensuration → le patron se regrade sous tes yeux, design préservé) ; l'aisance en un curseur ; la carte d'ajustement découvrable en un clic ; le bilan matière multi-tailles avec quantités, matelas mélangé et économie chiffrée (exact ≤ 220 pièces, extrapolé ±0,1 % au-delà) ; le plan de découpe multi-tailles étiqueté en un clic ; les crans posés automatiquement (couture + raccord, légendés) ; le brief IA et photo/croquis comme points d'entrée ; l'essayage en un clic sans jamais coudre ; et le navigateur — zéro installation, partage par lien.

## 6. Ce que CLO a que TOILE n'a pas (l'inventaire complet)

**Moteur/3D** : layering multi-vêtements, solidifier/figer/rigidifier, déchirure, plier, appuyer, vapeur, fronces 3D à la couture (force/angle du pli par couture), soudure des coutures fermées.
**Finitions** : boutons, boutonnières, fermetures (au-delà du zip TOILE), passepoil, biais, surpiqûre 3D, bande de couture, collage, éditeur UV complet.
**Patron pro** : traçage CAO au mm complet, gradation par points gradés, couture M:N avec contrôle d'embu, marge de couture par bord.
**Avatar** : ~13 mensurations + formes fines, bibliothèques d'avatars (enfants, mannequins, MetaHuman), poses IK et générateur de pose IA, costume d'essayage.
**Rendu** : PBR photoréaliste, rendu schématique/flat, rendu cloud.
**Formats** : BOM XML (Pacx), PLT traceur, PDF patron coté, USD/FBX/Alembic/VRM, coloris structurés.
**Confort** : auto-sauvegarde projet, historique complet, ruban de mesure sur le vêtement, recherche dans les menus.
**Écosystème** : CLO-SET (cloud, marketplace), CLOFAB (tissus scannés), plugins/Python.

Une partie de cette liste est volontairement hors-périmètre (le pari produit du blueprint : l'étage 2 pro n'est pas la cible) ; le reste est classé ci-dessous.

---

## 7. Ce qui reste, classé pour tes tests

**Bloquant pour élargir le test public au-delà du tee/robe/jupe (moteur, §18.2-18.3)**
1. Couture à convergence + soudure des coutures fermées (la cause des jonctions d'épaule du hoodie et des fils étirés).
2. Bouchage des trous par tag d'ouverture sur tous les chemins d'assemblage (poche du pantalon, canaux de doudoune).

**Important pour la crédibilité du test (petit, rapide)**
3. Calibration de la carte d'ajustement (le rouge trop généreux en haut de torse).
4. Micro-jours d'épaule du tee en T-pose (la pose 45° est propre — soit corriger, soit démarrer le test en pose 45°).
5. Auto-sauvegarde de session (CLO l'a ; un testeur grand public perd son travail au premier refresh).

**Polish différenciant (après le test)**
6. Offset réglable par pastille (l'éditeur fin de CLO) ; ruban de mesure sur le vêtement ; lecture numérique 2D vs 3D par pièce ; mode rendu schématique/flat ; coloris structurés ; PBR.

**Hors-navigateur (assumé, plus tard)**
7. Marketplace/cloud/partage, intégration façonnier, BOM XML/PLT/USD.

---

## 8. Verdict de solidité

**Oui, la base est assez solide pour lancer tes phases de test grand public — à condition de cadrer le périmètre.** Le parcours « je compose mon tee (blocs + aisance) → je le mets à MES mesures (curseurs, live) → je vois le tombé et où ça serre (carte + légende) → je change la matière et l'imprimé → je sors le dossier de production (fiche, plans mono/multi-tailles avec crans, DXF gradé, bilan matière chiffré) » est complet, validé pièce par pièce, et sur plusieurs points plus court et plus lisible que CLO lui-même. Robe et jupe peuvent accompagner. Pantalon et veste passent en « démo, réserves connues ». Hoodie et doudoune restent en beta interne tant que les chantiers 1-2 (couture/soudure/bouchage) ne sont pas faits — ce sont les deux seuls vrais chantiers moteur restants, et ils sont déjà spécifiés dans le blueprint (§18.2-18.3).

Dit autrement : **le « CLO du navigateur » existe pour le t-shirt, de la composition à l'usine.** La frontière n'est plus une liste de features — c'est la robustesse multi-pièces du moteur, mesurée, localisée, et spécifiée.

---

*Généré le 23/08/2026 — preuves : captures CLO (parcours modulaire, éditeur d'arrangement, propriétés), captures TOILE (7 essayages, carte, pose CLO), fichiers d'export capturés en session (techpack, markers, DXF, CSV). Versions : CLO 2026.1.188 (r58419) · TOILE v253 (`525b058`).*
