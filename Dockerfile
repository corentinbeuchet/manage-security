# Image de base : Java 25 (LTS), uniquement l'environnement d'exécution (JRE)
FROM eclipse-temurin:25-jre
WORKDIR /app
# Applique les correctifs de sécurité du système publiés depuis la construction de l'image de base
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
# Le jar construit (et testé) par Gradle
COPY build/libs/app.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
