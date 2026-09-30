# 🔐 Exercice 5 – Intégrer la sécurité au pipeline (DevSecOps) et le documenter

> 🎯 **Priorités** : les parties 1, 2, 2 bis, 3, 5, 6 (CodeQL) et 7 sont l'essentiel, ce que vous devrez savoir refaire seul à l'évaluation finale. La partie 4 et Dependabot (partie 6) sont pour aller plus loin, si le temps le permet.

## 📌 Contexte
Vous avez terminé l'exercice 4 :
- ✅ Pipeline CI/CD : build, tests, qualité, livrable
- ✅ Image Docker testée
- ✅ Déploiement multi-environnements avec Ansible
- ✅ Protection des branches `main` et `develop`

Votre pipeline vérifie que le code **fonctionne**. Il ne vérifie pas encore qu'il est **sûr**. Vous allez le transformer en **pipeline DevSecOps** : des contrôles de sécurité automatiques, **avant** tout déploiement. Puis vous le **documenterez**, pour qu'un nouvel arrivant le comprenne sans vous.

Pipeline visé :

```
Pull Request : (build → docker + scan de l'image + scan de l'appli) + scan des dépendances + scan des secrets → déploiement TEST
Push develop / main : (build → docker + scan de l'image + scan de l'appli) + scan des secrets → déploiement DEV / PROD
```

---

## 🎯 Ce que vous devez comprendre et savoir faire
À la fin de cet exercice, vous devez être capable de :
- **Expliquer « shift left »** : trouver un problème de sécurité dans une PR coûte bien moins cher qu'en production.
- **Distinguer les familles de contrôles** : dépendances vulnérables (SCA), secrets exposés, failles dans votre propre code (SAST), image Docker vulnérable, application mal configurée une fois lancée (DAST).
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

### 🔧 Activer le dependency graph
Il est **désactivé** sur un nouveau dépôt. Dans **Settings → Advanced Security**, ligne **Dependency graph**, cliquez **Enable**.
Sans cela, le job `dependency-submission` échoue avec : `The Dependency graph is disabled for this repository`.

### 🔧 Étape 1 : envoyer le graphe (PR n°1)
Ajoutez ce job dans `.github/workflows/ci-cd.yml` :

```yaml
  dependency-submission:
    runs-on: ubuntu-26.04
    permissions:
      contents: write        # nécessaire pour envoyer le graphe à GitHub
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-java@v6
        with:
          distribution: 'temurin'
          java-version: '25'
      - name: Envoyer le graphe des dépendances
        uses: gradle/actions/dependency-submission@v6
```

PR vers `develop`, CI verte, **merge**. Le push sur `develop` envoie le graphe de référence : c'est lui qui servira de point de comparaison.

> Vous pouvez le consulter dans l'onglet **Insights → Dependency graph** du dépôt.

### 🔧 Étape 2 : comparer (PR n°2)
Sur une nouvelle branche, ajoutez le second job :

```yaml
  dependency-review:
    if: github.event_name == 'pull_request'
    needs: dependency-submission
    runs-on: ubuntu-26.04
    permissions:
      contents: read
    steps:
      - name: Dependency Review
        uses: actions/dependency-review-action@v5
        with:
          retry-on-snapshot-warnings: true
          retry-on-snapshot-warnings-timeout: 60   # attendre (1 min max) que le graphe de la branche cible soit disponible
```

PR vers `develop`, CI verte, merge.

📌 À comprendre :
- `dependency-submission` tourne **à chaque push et chaque PR** : GitHub garde ainsi à jour le graphe de `main` et `develop`.
- `dependency-review` ne tourne **que sur les PR** : il compare la PR à la branche cible. Sur un simple push, il n'y a rien à comparer.
- `needs: dependency-submission` garantit que le graphe de la PR est envoyé **avant** la comparaison.
- Le scan ne signale que ce que la PR **ajoute ou modifie**. C'est pour cela qu'on envoie d'abord le graphe de référence (étape 1) : sans lui (message `The number of snapshots compared for the base SHA (0)…`), toutes les dépendances sont vues comme nouvelles, et la moindre vulnérabilité déjà présente bloque la PR.

---

## 🧩 Partie 2 – Scan des secrets

### 🎯 Pourquoi ?
Un développeur peut, par erreur, committer un mot de passe, une clé d'API, un token ou une clé privée. Une fois poussé, il est dans l'**historique** Git : il faut le considérer comme **compromis**.

### 🔧 Ajouter le job `secret-scan`

```yaml
  secret-scan:
    runs-on: ubuntu-26.04
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

## 🧩 Partie 2 bis – Scanner l'image et l'application en marche

### 🎯 Pourquoi ?
Le scan des dépendances ne regarde que `build.gradle`. Or ce qui part en production, c'est **l'image Docker** : un système (paquets Linux), un JRE, et votre jar. Une faille peut se cacher dans chacun.
Et certains problèmes n'apparaissent que **quand l'application tourne** : en-têtes de sécurité absents, informations qui fuient dans les réponses, mauvaise configuration.

| Contrôle | Ce qu'il regarde | Outil |
|---|---|---|
| Scan de l'image | Paquets du système, JRE, bibliothèques du jar | Trivy |
| Scan dynamique (DAST) | L'application lancée, vue de l'extérieur | ZAP (baseline) |

### 🔧 Ajouter deux étapes à la fin du job `docker`
L'image vient d'être construite et le conteneur tourne : c'est le bon endroit.

```yaml
      # ----- Exercice 5 : scanner l'image, puis l'application en marche -----
      - name: Scanner l'image (Trivy)
        # Épinglé par SHA : les tags de trivy-action ont été détournés en mars 2026
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: demo:${{ github.sha }}
          severity: CRITICAL,HIGH
          ignore-unfixed: true     # ne bloque que si un correctif existe
          exit-code: '1'           # une faille HIGH ou CRITICAL fait échouer le job
      - name: Scanner l'application en marche (ZAP baseline)
        uses: zaproxy/action-baseline@de8ad967d3548d44ef623df22cf95c3b0baf8b25 # v0.15.0
        with:
          target: http://localhost:8080/hello
          allow_issue_writing: false   # rapport en artefact, pas d'issue GitHub
```

📌 Pourquoi un SHA et pas `@v0.36.0` ? Un tag peut être déplacé vers un autre code : c'est exactement ce qui est arrivé à `trivy-action` en mars 2026. Un SHA de commit ne bouge jamais. Le commentaire `# v0.36.0` reste lisible pour vous, et Dependabot (si vous l'activez pour `github-actions`, partie 6) met à jour les deux.

### 🔍 Lire les résultats
- **Trivy** : le tableau est dans le log de l'étape (bibliothèque, CVE, gravité, version installée, version corrigée).
- **ZAP** : téléchargez l'artefact `zap_scan` en bas de la page du run et ouvrez `report_html.html`. Le baseline ne fait **pas** échouer le job par défaut : il vous montre des alertes (niveau *WARN* : quelques en-têtes de sécurité manquants sur une API Spring Boot par défaut), à vous de décider.

### 🚦 Si Trivy bloque
Attendez-vous à un premier passage **rouge** : fin septembre 2026, Trivy trouvait des failles corrigées mais pas encore livrées par Spring Boot (Tomcat embarqué, Jackson) et par l'image de base (OpenSSL). C'est le cœur de l'exercice : lire, décider, corriger.

1. Lisez le tableau : quelle bibliothèque, quelle version corrige (colonne *Fixed Version*) ?
2. **Une bibliothèque du jar** gérée par Spring Boot : forcez la version corrigée dans `build.gradle`, avec un commentaire qui dit quand l'enlever :
   ```groovy
   // Correctifs signalés par Trivy, pas encore livrés par Spring Boot : à retirer dès qu'il les embarque
   ext['tomcat.version'] = '11.0.25'
   ext['jackson-bom.version'] = '3.1.6'
   ```
   (le nom de la propriété se trouve dans la documentation de Spring Boot, *Dependency Versions → Version Properties* ; les numéros sont ceux que Trivy vous donne)
3. **Un paquet du système** de l'image de base : appliquez les mises à jour de sécurité dans le `Dockerfile`, juste après `WORKDIR` :
   ```dockerfile
   RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
   ```
4. Si aucune version corrigée n'existe encore par ces chemins, vous pouvez **accepter le risque, par écrit** : créez un fichier `.trivyignore` à la racine, avec l'identifiant et une justification :
   ```
   # <bibliothèque> : pas de correctif disponible au JJ/MM/AAAA (revoir le JJ/MM/AAAA)
   CVE-AAAA-NNNNN
   ```
   et ajoutez `trivyignores: .trivyignore` dans le `with:` de l'étape Trivy. Une exception non justifiée, sans date de revue, c'est désactiver le contrôle.

### 🔧 Et pour ZAP ?
Dans le rapport, choisissez **une** alerte (par exemple un en-tête de sécurité manquant) et expliquez dans la PR : ce qu'elle signifie, si elle est pertinente pour une API, et comment vous la corrigeriez. Pas besoin de tout corriger : il faut savoir **lire** et **décider**.

---

## 🧩 Partie 3 – Aucun déploiement sans sécurité

Les scans de l'image et de l'application sont dans le job `docker`, dont dépendent déjà les déploiements. Modifiez les `needs` des jobs de déploiement pour les deux autres scans :

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
Dans **Settings → Advanced Security**, section **Code scanning → CodeQL analysis**, cliquez **Set up → Default**, puis **Enable CodeQL**.
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

> 💡 L'onglet **Security → Dependabot** signalera sans doute des vulnérabilités dans des bibliothèques que vous n'avez jamais ajoutées vous-même (Tomcat, par exemple) : elles viennent de Spring Boot. La correction passe par une version plus récente de Spring Boot, que Dependabot vous proposera dans une PR.

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
4. **Une section « Que faire si… »** : le build échoue, Checkstyle échoue, un secret est détecté, une dépendance est vulnérable, Trivy bloque sur l'image, la prod est en maintenance. Pour chaque cas : où lire l'erreur, et comment corriger.

Faites relire ce README par un camarade qui ne connaît pas votre dépôt : s'il comprend comment déployer et quoi faire quand ça échoue, votre documentation est bonne.

---

## 🧠 Questions de réflexion
1. Pourquoi la sécurité doit-elle être automatisée, et intégrée **tôt** dans le pipeline ?
2. Quelle différence entre DevOps et DevSecOps ?
3. Quelle différence entre le scan des dépendances, le scan des secrets, CodeQL, Trivy et ZAP ? Donnez un exemple de problème que seul chacun d'eux détecte.
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
- des scans de dépendances, de secrets, de code, de l'image et de l'application en marche
- des secrets gérés hors du code
- des mises à jour automatiques
- un pipeline documenté, compréhensible par quelqu'un d'autre que vous
