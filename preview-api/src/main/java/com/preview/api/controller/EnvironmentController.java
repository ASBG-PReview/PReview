package com.preview.api.controller;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 이 Pod가 어떤 PR / Commit / Namespace로 배포됐는지 알려주는 API.
 * 값은 코드에 고정하지 않고 k8s Deployment의 환경변수로 주입받는다.
 * 환경변수가 없으면 콜론(:) 뒤의 기본값을 사용한다. (로컬 실행 시 local / unknown)
 */
@RestController
public class EnvironmentController {

    @Value("${PR_NUMBER:local}")
    private String prNumber;

    @Value("${COMMIT_SHA:unknown}")
    private String commitSha;

    @Value("${NAMESPACE:local}")
    private String namespace;

    @GetMapping("/environment")
    public EnvironmentResponse environment() {
        return new EnvironmentResponse(prNumber, commitSha, namespace);
    }

    /** JSON 응답 형태: {"prNumber": "...", "commitSha": "...", "namespace": "..."} */
    public record EnvironmentResponse(String prNumber, String commitSha, String namespace) {
    }
}
