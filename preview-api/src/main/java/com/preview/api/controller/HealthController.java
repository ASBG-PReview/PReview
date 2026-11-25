package com.preview.api.controller;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Pod 상태 확인용 API.
 * k8s Readiness/Liveness Probe가 이 주소를 호출해서 200이 오면 정상으로 판단한다.
 */
@RestController
public class HealthController {

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }
}
