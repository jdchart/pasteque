# pasteque

Leçons et outils interactifs d’écoute et d’analyse sonore pour les étudiants, publiés avec GitHub Pages.

**Site :** https://jdchart.github.io/pasteque/

L’application (menu Session / Apprendre / Bac à sable, onglets) s’ouvre à la racine. **Apprendre** présente les cours, module par module, avec chaque outil en version guidée (la mise en page des pages d’origine) ; le **Bac à sable** propose les mêmes outils en version application, sans le récit. Tout est calculé dans le navigateur ; le seul moyen de garder son travail est d’**enregistrer la session** (un fichier `.pasteque.json` à télécharger, puis à rouvrir). Rien n’est conservé dans le navigateur.

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
