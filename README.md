# 🔐 Exercice 5 – Intégrer la sécurité au pipeline (DevSecOps) et le documenter

## 📌 Contexte
Vous avez terminé l'exercice 4 :
- ✅ Pipeline CI/CD : build, tests, qualité, livrable
- ✅ Image Docker testée
- ✅ Déploiement multi-environnements avec Ansible
- ✅ Protection des branches `main` et `develop`

Votre pipeline vérifie que le code **fonctionne**. Il ne vérifie pas encore qu'il est **sûr**. Vous allez le transformer en **pipeline DevSecOps** : des contrôles de sécurité automatiques, **avant** tout déploiement. Puis vous le **documenterez**, pour qu'un nouvel arrivant le comprenne sans vous.

Pipeline visé :

```
Pull Request : (build → docker) + scan des dépendances + scan des secrets → déploiement TEST
Push develop / main : (build → docker) + scan des secrets → déploiement DEV / PROD
```

---

## 🎯 Ce que vous devez comprendre et savoir faire
À la fin de cet exercice, vous devez être capable de :
- **Expliquer « shift left »** : trouver un problème de sécurité dans une PR coûte bien moins cher qu'en production.
- **Distinguer les familles de contrôles** : dépendances vulnérables (SCA), secrets exposés, failles dans votre propre code (SAST).
- **Réagir à une alerte** : lire le rapport, comprendre le risque, corriger la cause (et pas désactiver le contrôle).
- **Expliquer pourquoi un secret poussé une fois est compromis**, même si on le supprime au commit suivant.
- **Utiliser un secret dans un pipeline sans l'écrire dans le code** (GitHub Secrets).
- **Garder ses dépendances et ses actions à jour automatiquement** (Dependabot).
- **Documenter un pipeline** : ce qu'il fait, dans quel ordre, et quoi faire quand il échoue.

---

## 🧩 Partie 0 – Point de départ
Continuez dans **votre dépôt de l'exercice 4**, sur une branche partant de `develop` :
```bash
git switch develop
git pull
git switch -c feat/devsecops
```

> Exercice 4 non terminé ? Partez de [ce dépôt](https://github.com/corentinbeuchet/manage-security), comme expliqué dans la partie 0 de l'exercice 4, puis créez et protégez `develop`.
>
> ⚠️ Avant votre premier push, redonnez à `gradlew` son droit d'exécution (le piège de l'exercice 3) : `git update-index --chmod=+x gradlew`, puis `git commit -m "fix: make gradlew executable"`.

Chaque partie ci-dessous se termine par : commit, push, PR vers `develop`, CI verte, merge.

---

## 🧩 Partie 1 – Scan des dépendances (SCA)

### 🎯 Pourquoi ?
Votre application embarque des dizaines de bibliothèques. Certaines versions ont des vulnérabilités connues et publiées (des **CVE**). Le but : refuser une PR qui **introduit** une dépendance vulnérable.

### Comment ça marche ici
1. GitHub doit connaître la liste de vos dépendances (le **dependency graph**). Pour Gradle, il ne sait pas la lire tout seul : c'est l'action `gradle/actions/dependency-submission` qui la calcule et la lui envoie.
2. `dependency-review-action` compare ensuite les dépendances de la PR à celles de la branche cible, et échoue si la PR ajoute une dépendance vulnérable.

### 🔧 Ajouter deux jobs dans `.github/workflows/ci-cd.yml`

```yaml
  dependency-submission:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # nécessaire pour envoyer le graphe à GitHub
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-java@v5
        with:
          distribution: 'temurin'
          java-version: '25'
      - name: Envoyer le graphe des dépendances
        uses: gradle/actions/dependency-submission@v6

  dependency-review:
    if: github.event_name == 'pull_request'
    needs: dependency-submission
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Dependency Review
        uses: actions/dependency-review-action@v5
        with:
          retry-on-snapshot-warnings: true
          retry-on-snapshot-warnings-timeout: 600   # attendre (10 min max) que le graphe soit envoyé
```

📌 À comprendre :
- `dependency-submission` tourne **à chaque push et chaque PR** : GitHub garde ainsi à jour le graphe de `main` et `develop`, qui sert de référence.
- `dependency-review` ne tourne **que sur les PR** : il a besoin de deux versions à comparer (la branche cible et la PR). Sur un simple push, il échouerait.
- Sur la **première** PR, `develop` n'a pas encore de graphe envoyé : le job peut attendre plusieurs minutes, voire signaler toutes les dépendances comme nouvelles. Après le merge (push sur `develop`), la référence existe et les PR suivantes ne montrent que les vraies différences.

---

## 🧩 Partie 2 – Scan des secrets

### 🎯 Pourquoi ?
Un développeur peut, par erreur, committer un mot de passe, une clé d'API, un token ou une clé privée. Une fois poussé, il est dans l'**historique** Git : il faut le considérer comme **compromis**.

### 🔧 Ajouter le job `secret-scan`

```yaml
  secret-scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # Gitleaks commente la PR quand il trouve un secret
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0     # tout l'historique, pas seulement le dernier commit
      - name: Gitleaks
        uses: gitleaks/gitleaks-action@v3
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> Gitleaks est gratuit pour un dépôt sur un compte personnel. Sur un dépôt d'organisation, il demande une licence (gratuite) : restez sur votre compte personnel.

---

## 🧩 Partie 3 – Aucun déploiement sans sécurité

Modifiez les `needs` des jobs de déploiement :

```yaml
  deploy-test:
    needs: [docker, dependency-review, secret-scan]
    # ... inchangé

  deploy-dev:
    needs: [docker, secret-scan]
    # ... inchangé

  deploy-prod:
    needs: [docker, secret-scan]
    # ... inchangé
```

📌 Pourquoi `dependency-review` n'est-il pas dans les `needs` de dev et prod ?
Sur un push, ce job est **ignoré** (il ne tourne que sur les PR). Or un job dont un `needs` a été ignoré est ignoré lui aussi : dev et prod ne se déploieraient **jamais**.
La protection vient d'ailleurs : `main` et `develop` n'acceptent que des PR, et c'est **sur la PR** que le scan est bloquant.

### 🔒 Rendre les scans obligatoires
Une fois les jobs lancés au moins une fois, ajoutez `dependency-review` et `secret-scan` aux **checks obligatoires** des règles de `main` et `develop` (**Settings → Branches**, bouton **Edit** sur chaque règle).

---

## 🧪 Partie 4 – Tests pédagogiques

### 1️⃣ Simuler un secret exposé
Sur une nouvelle branche, créez `src/main/resources/application-dev.yml` :

```yaml
database:
  url: jdbc:mysql://localhost:3306/app
  username: admin
  password: ghp_0123456789abcdefghijklmnopqrstuvwxyzABCD
```

Commit → push → PR vers `develop`.

Résultats attendus :
- ❌ le job `secret-scan` échoue : Gitleaks signale le token, avec le fichier, la ligne et le commit (voir aussi le commentaire sur la PR et le résumé du job)
- ❌ `Deploy TEST` n'est pas lancé, et la PR ne peut pas être mergée

> 💡 GitHub peut aussi refuser votre push directement (message `GH013`, *push protection*) s'il reconnaît un vrai token. C'est une protection de plus, **avant** même la CI.

Supprimez le fichier, commit, push.
📌 Le job reste **rouge** : le secret est toujours dans **l'historique** de la branche, et Gitleaks le scanne. Dans la vraie vie, la seule correction sûre est de **révoquer** le secret, puis de nettoyer l'historique. Ici, fermez la PR et supprimez la branche.

### 2️⃣ Simuler une dépendance vulnérable
Sur une nouvelle branche, ajoutez dans le bloc `dependencies` de `build.gradle` une version connue pour être vulnérable (Log4Shell, 2021) :

```groovy
implementation 'org.apache.logging.log4j:log4j-core:2.14.1'
```

Commit → push → PR vers `develop`.

Résultats attendus :
- ❌ le job `dependency-review` échoue et liste les vulnérabilités (gravité, identifiant, version corrigée)
- (le `build` peut aussi échouer, cette vieille version se mariant mal avec les bibliothèques récentes : ce n'est pas le sujet, regardez le rapport de `dependency-review`)
- ❌ aucun déploiement, merge bloqué

Supprimez la ligne, commit, push : ✅ tout repasse au vert. Fermez la PR sans la merger.

---

## 🧩 Partie 5 – Utiliser un secret, proprement

Un déploiement réel a besoin d'identifiants (registre Docker, serveur, cloud…). Ils ne doivent **jamais** être dans le code.

1. Dans **Settings → Secrets and variables → Actions → New repository secret**, créez `DEPLOY_TOKEN` avec une valeur inventée.
   Créez-le aussi dans **Settings → Secrets and variables → Dependabot** : les workflows lancés par Dependabot (partie 6) n'ont **pas** accès aux secrets Actions, seulement aux siens.
2. Dans le job `deploy-dev`, passez-le à Ansible par une variable d'environnement :
   ```yaml
      - run: ansible-playbook -i ansible/inventory/dev.ini ansible/playbook.yml -e image_tag=${{ github.sha }}
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
   ```
3. En **première** tâche de `ansible/playbook.yml`, vérifiez qu'il est bien présent :
   ```yaml
       - name: Vérifier la présence du token de déploiement
         ansible.builtin.assert:
           that: lookup('env', 'DEPLOY_TOKEN') | length > 0
           fail_msg: "DEPLOY_TOKEN manquant"
           quiet: true
   ```
   Faites de même (`env:`) pour `deploy-test` et `deploy-prod`, sinon cette vérification les fera échouer.
   En local, exportez-le avant de lancer le playbook : `export DEPLOY_TOKEN=local-test`.
4. Ajoutez une étape de débogage qui l'affiche : `- run: echo "Token = $DEPLOY_TOKEN"` (avec le même `env:`). Regardez le log : GitHub affiche `***`. Puis **supprimez** cette étape : le masquage est un filet de sécurité, pas une raison d'afficher un secret.

---

## 🧩 Partie 6 – Analyse du code et mises à jour automatiques

### CodeQL : les failles dans **votre** code (SAST)
Dans **Settings → Advanced Security** (ou **Code security** selon l'interface), section **Code scanning → CodeQL analysis**, cliquez **Set up → Default**, puis **Enable CodeQL**.
Aucun fichier à écrire : GitHub analyse le code à chaque PR et chaque push. Les résultats sont dans l'onglet **Security → Code scanning**.

### Dependabot : rester à jour sans y penser
Créez `.github/dependabot.yml` :

```yaml
version: 2
updates:
  - package-ecosystem: "gradle"
    directory: "/"
    target-branch: "develop"   # les mises à jour suivent le même chemin que votre code
    schedule:
      interval: "weekly"
  - package-ecosystem: "github-actions"
    directory: "/"
    target-branch: "develop"   # les mises à jour suivent le même chemin que votre code
    schedule:
      interval: "weekly"
  - package-ecosystem: "docker"
    directory: "/"
    target-branch: "develop"   # les mises à jour suivent le même chemin que votre code
    schedule:
      interval: "weekly"
```

Dans **Settings → Advanced Security**, activez aussi **Dependabot alerts** et **Dependabot security updates**.
Dependabot ouvrira des PR de mise à jour : elles passeront par **tout** votre pipeline avant d'être mergées.

📌 Les versions des actions (`checkout@v7`…) vieillissent aussi : GitHub retire régulièrement les anciennes versions de Node.js de ses runners, et les actions trop anciennes cessent de fonctionner. Dependabot vous prévient.

---

## 🧩 Partie 7 – Documenter le pipeline

Un pipeline que seul son auteur comprend est un risque. Dans le `README.md` de votre dépôt, ajoutez :

1. **Un badge** qui montre l'état du pipeline sur `main` :
   ```markdown
   ![CI/CD](https://github.com/<votre-compte>/<votre-depot>/actions/workflows/ci-cd.yml/badge.svg?branch=main)
   ```
2. **Un schéma** du pipeline. GitHub affiche directement les diagrammes Mermaid :
   ````markdown
   ```mermaid
   flowchart LR
     PR[Pull Request] --> B[build]
     B --> D[docker]
     B -.-> P[performance]
     PR --> DS[dependency-submission] --> DR[dependency-review]
     PR --> S[secret-scan]
     D & DR & S --> T[Deploy TEST]
   ```
   ````
   Complétez-le avec les chemins `develop → DEV` et `main → PROD`.
3. **Une section « Comment ça marche »** : ce que fait chaque job, ce qui déclenche chaque déploiement, et quels checks sont obligatoires sur `main` et `develop`.
4. **Une section « Que faire si… »** : le build échoue, Checkstyle échoue, un secret est détecté, une dépendance est vulnérable, la prod est en maintenance. Pour chaque cas : où lire l'erreur, et comment corriger.

Faites relire ce README par un camarade qui ne connaît pas votre dépôt : s'il comprend comment déployer et quoi faire quand ça échoue, votre documentation est bonne.

---

## 🧠 Questions de réflexion
1. Pourquoi la sécurité doit-elle être automatisée, et intégrée **tôt** dans le pipeline ?
2. Quelle différence entre DevOps et DevSecOps ?
3. Quelle différence entre le scan des dépendances, le scan des secrets et CodeQL ? Donnez un exemple de problème que seul chacun d'eux détecte.
4. Pourquoi supprimer un secret dans un nouveau commit ne suffit-il pas ?
5. Pourquoi la production ne doit-elle jamais contourner ces contrôles ?
6. Un scan vert signifie-t-il que l'application est sûre ?

---

## ✅ Conclusion
Votre projet est passé de :

**CI/CD** → **CI/CD + sécurité intégrée + documentation = DevSecOps**

Vous avez maintenant :
- des tests automatisés, un contrôle qualité et un test de performance
- un livrable unique, conteneurisé, promu de TEST à PROD
- de l'Infrastructure as Code (Ansible)
- des scans de dépendances, de secrets et de code
- des secrets gérés hors du code
- des mises à jour automatiques
- un pipeline documenté, compréhensible par quelqu'un d'autre que vous
