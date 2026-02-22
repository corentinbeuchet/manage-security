# 🔐 Exercice complémentaire -- Ajout de la Sécurité (DevSecOps)

------------------------------------------------------------------------

## 📌 Contexte

Vous avez terminé l'exercice précédent :

-   ✅ Pipeline CI/CD fonctionnelle\
-   ✅ Tests automatisés\
-   ✅ Déploiement multi-environnements avec Ansible\
-   ✅ Protection des branches `main` et `develop`

Votre pipeline permet maintenant :

Tests → Déploiement DEV / TEST / PROD

Nous allons maintenant la transformer en **pipeline DevSecOps** en y
intégrant des contrôles de sécurité automatisés.

------------------------------------------------------------------------

# 🎯 Objectif de cet exercice

Ajouter des **contrôles de sécurité obligatoires** dans votre pipeline
avant tout déploiement.

Pipeline attendue :

Tests ↓ Scan des dépendances ↓ Scan des secrets ↓ Déploiement DEV / TEST
↓ Déploiement PROD (si tout est conforme)

------------------------------------------------------------------------

# 🧩 Partie 1 -- Ajouter un scan des dépendances (SCA)

## 🎯 Pourquoi ?

Certaines dépendances peuvent contenir des vulnérabilités connues
(CVE).\
Nous devons empêcher leur déploiement en production.

## 🔧 Étape à réaliser

Dans votre fichier :

.github/workflows/ci-cd.yml

Ajouter un nouveau job nommé `security-check` :

``` yaml
security-check:
  name: Security - Dependency Scan
  runs-on: ubuntu-latest
  needs: test
  steps:
    - uses: actions/checkout@v4
    - name: Dependency Review
      uses: actions/dependency-review-action@v4
```

------------------------------------------------------------------------

# 🧩 Partie 2 -- Ajouter un scan de secrets

## 🎯 Pourquoi ?

Un développeur peut accidentellement commiter :

-   mot de passe
-   clé API
-   token
-   clé privée

Cela doit bloquer immédiatement la pipeline.

## 🔧 Étape à réaliser

Ajouter un second job `secret-scan` :

``` yaml
secret-scan:
  name: Security - Secret Scan
  runs-on: ubuntu-latest
  needs: test
  steps:
    - uses: actions/checkout@v4
    - name: Install Gitleaks
      uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    - name: Run Gitleaks
      run: ./gitleaks detect --source . --exit-code 1
```

------------------------------------------------------------------------

# 🧩 Partie 3 -- Rendre la production dépendante de la sécurité

Modifier le job `deploy-prod` pour qu'il dépende aussi des contrôles
sécurité.

Remplacer :

needs: test

Par :

needs: \[test, security-check, secret-scan\]

Faire la même modification pour `deploy-dev` et `deploy-test`.

------------------------------------------------------------------------

# 🧪 Partie 4 -- Tests pédagogiques obligatoires

## 1️⃣ Simuler un secret exposé

Ajouter volontairement dans un fichier :

password=SuperSecret123

Commit → Push

Résultat attendu :\
❌ Le job `secret-scan` échoue\
❌ Aucun déploiement n'a lieu

Supprimer le secret → nouveau commit → succès attendu.

------------------------------------------------------------------------

## 2️⃣ Simuler une dépendance vulnérable

Ajouter volontairement une dépendance connue vulnérable dans
`build.gradle`.

Résultat attendu :\
❌ Le job `security-check` échoue\
❌ Aucun déploiement n'a lieu

Corriger la dépendance → succès attendu.

------------------------------------------------------------------------

# 🧠 Questions de réflexion

1.  Pourquoi la sécurité doit-elle être automatisée ?
2.  Quelle différence entre DevOps et DevSecOps ?
3.  Pourquoi ne jamais ignorer un scan de sécurité ?
4.  Pourquoi la production ne doit jamais contourner ces contrôles ?
5.  Que se passerait-il si un secret arrivait en production ?

------------------------------------------------------------------------

# ✅ Conclusion

Avec cet ajout, votre projet passe de :

CI/CD

À :

CI/CD + Sécurité intégrée = DevSecOps

Vous avez maintenant :

-   Tests automatisés
-   Déploiements multi-environnements
-   Infrastructure as Code
-   Scan des dépendances
-   Détection de secrets
-   Blocage automatique de la production
