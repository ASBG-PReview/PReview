FROM eclipse-temurin:21-jdk AS packaged
WORKDIR /app
COPY gradlew build.gradle settings.gradle ./
COPY gradle ./gradle
COPY src/main ./src/main
RUN chmod +x gradlew && ./gradlew clean bootJar --no-daemon && cp build/libs/*.jar app.jar

# Tests can write to their own copy of the build directory, including its JAR.
FROM packaged AS tested
COPY src/test ./src/test
RUN ./gradlew test --no-daemon && touch /tests-passed

# Require the test stage to succeed while keeping its writable filesystem out of the runtime.
FROM packaged AS verified
COPY --from=tested /tests-passed /checks/tests-passed

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=verified /app/app.jar /app/app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
