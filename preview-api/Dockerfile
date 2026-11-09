FROM gradle:8.14.3-jdk21@sha256:21bd311ed01360c189b8870c6b6e988199ff10f72d445d02fb39d3cff9da91d7 AS distribution

FROM eclipse-temurin:25-jdk AS packaged
COPY --from=distribution /opt/gradle /opt/gradle
ENV PATH="/opt/gradle/bin:${PATH}"
WORKDIR /app
COPY build.gradle settings.gradle ./
COPY gradle ./gradle
COPY src/main ./src/main
# Keep container builds on the same Gradle version as the local wrapper.
RUN version=$(gradle --version | awk '$1 == "Gradle" {print $2}') && \
    grep -Fqx "distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip" gradle/wrapper/gradle-wrapper.properties && \
    gradle clean bootJar --no-daemon && cp build/libs/*.jar app.jar

# Tests can write to their own copy of the build directory, including its JAR.
FROM packaged AS tested
COPY src/test ./src/test
RUN gradle verifyPreviewTests --no-daemon && touch /tests-passed

# Require the test stage to succeed while keeping its writable filesystem out of the runtime.
FROM packaged AS verified
COPY --from=tested /tests-passed /checks/tests-passed

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=verified /app/app.jar /app/app.jar
USER 10001:10001
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=6 \
  CMD ["curl", "--fail", "--silent", "--show-error", "--max-time", "2", "http://127.0.0.1:8080/health"]
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
