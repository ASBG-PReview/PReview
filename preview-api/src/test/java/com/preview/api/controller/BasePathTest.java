package com.preview.api.controller;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;

class BasePathTest {
    abstract static class Contract {
        @Autowired TestRestTemplate client;
        @LocalServerPort int port;
        @Value("${BASE_PATH:}") String basePath;

        @Test
        void servesAllEndpointsUnderConfiguredPath() {
            String origin = "http://localhost:" + port;
            for (String endpoint : new String[]{"health", "environment", "version"}) {
                var response = client.getForEntity(origin + basePath + "/" + endpoint, Map.class);
                assertThat(response.getStatusCode().value()).isEqualTo(200);
                assertThat(response.getBody()).isNotEmpty();
            }
            assertThat(client.getForObject(origin + basePath + "/health", Map.class)).containsEntry("status", "ok");
            if (!basePath.isEmpty()) {
                assertThat(client.getForEntity(origin + "/health", String.class).getStatusCode().value()).isEqualTo(404);
            }
        }
    }

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
    class Root extends Contract {}

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "BASE_PATH=/container-2/main")
    class Main extends Contract {}

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "BASE_PATH=/container-2/pr-17")
    class PullRequest extends Contract {}
}
