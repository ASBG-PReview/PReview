
# 1단계: Java 21로 빌드
FROM eclipse-temurin:21-jdk AS builder

WORKDIR /app

COPY . .

RUN chmod +x ./gradlew
RUN ./gradlew clean test bootJar --no-daemon

RUN cp build/libs/*.jar /app/app.jar

# 2단계: 실행 전용 이미지
FROM eclipse-temurin:21-jre

WORKDIR /app

COPY --from=builder /app/app.jar /app/app.jar

EXPOSE 8080

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
