# pasteque

Leçons et outils interactifs d’écoute et d’analyse sonore pour les étudiants, publiés avec GitHub Pages.

**Site :** https://jdchart.github.io/pasteque/

L’application (menu Session / Apprendre / Bac à sable, onglets) s’ouvre à la racine. **Apprendre** présente les cours, module par module, avec chaque outil en version guidée (la mise en page des pages d’origine) ; le **Bac à sable** propose les mêmes outils en version application, sans le récit. Tout est calculé dans le navigateur ; le seul moyen de garder son travail est d’**enregistrer la session** (un fichier `.pasteque.json` à télécharger, puis à rouvrir). Rien n’est conservé dans le navigateur.

## Les outils

| Outil | Ce qu’on y fait |
|---|---|
| Forme d’onde et échantillonnage | Amplitude, période, échantillons, repliement |
| Synthèse additive | Empiler des sinusoïdes jusqu’au timbre |
| Bac à sable FFT | La fenêtre d’analyse comme variable |
| Descripteurs audio | Prédire puis mesurer intensité, hauteur, centroïde, planéité, MFCC… |
| Atelier spectral | Séparer harmonique / percussif, tonal / transitoires / résidu, NMF, réduction de bruit, sélection temporelle et masque dessiné sur le spectrogramme ; chaque couche s’écoute, s’exporte en WAV ou rejoint les sons de la session |
| Segmentation | Couper par flux spectral, détection d’attaques (flux log, HFC, domaine complexe, énergie), transitoires, ou matrice d’auto-similarité (spectre, MFCC, chroma, descripteurs au choix) ; forme d’onde avec segments numérotés |
| Corpus | Les corpus de la session : segments de la segmentation, sons entiers, passages choisis à la main sur la forme d’onde, corpus.json / segments.csv importés ; renommer, recouper, retirer, copier entre corpus, fusionner ; export JSON, CSV, WAV |
| Description par lot | Décrire un corpus de la session (la description est gardée dans le corpus), trier, réécouter |
| Carte sonore | Projeter le corpus par PCA, MDS, Isomap, t-SNE, UMAP ou deux descripteurs, puis le jouer |

Chaque outil existe en version guidée (Apprendre) et en version application (Bac à sable), avec les mêmes méthodes.

## Pages classiques (anciennes adresses, toujours en ligne)

| Outil | Page |
|---|---|
| Bac à sable FFT | [ats-bac-a-sable-fft.html](https://jdchart.github.io/pasteque/ats-bac-a-sable-fft.html) |
| Carte sonore | [ats-carte-sonore.html](https://jdchart.github.io/pasteque/ats-carte-sonore.html) |
| Description par lot | [ats-description-par-lot.html](https://jdchart.github.io/pasteque/ats-description-par-lot.html) |
| Forme d'onde | [ats-forme-onde.html](https://jdchart.github.io/pasteque/ats-forme-onde.html) |
| Segmentation | [ats-segmentation.html](https://jdchart.github.io/pasteque/ats-segmentation.html) |
| Synthèse additive | [ats-synthese-additive.html](https://jdchart.github.io/pasteque/ats-synthese-additive.html) |
| Descripteurs audio | [general-descripteurs-audio.html](https://jdchart.github.io/pasteque/general-descripteurs-audio.html) |
| Guide des descripteurs | [general-guide-descripteurs.html](https://jdchart.github.io/pasteque/general-guide-descripteurs.html) |

L’ancienne page d’accueil reste disponible : [classique.html](https://jdchart.github.io/pasteque/classique.html).

Chaque page classique est autonome (HTML + CSS + JS + Meyda intégrés) : elle fonctionne aussi hors ligne, en ouvrant le fichier directement.

## Développement

```sh
cd app
npm install
npm run dev        # serveur local avec rechargement
npm run site       # vérifie les types, construit, assemble app/site/ (app + pages classiques)
```

`app/site/` est exactement ce qui est publié ; il s’ouvre aussi par `file://` (clé USB, sans serveur).
La publication se fait par GitHub Actions (`.github/workflows/deploy.yml`) à chaque push sur `main`.
