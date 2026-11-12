package com.preview.api.controller;

import org.springframework.boot.info.BuildProperties;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class VersionController {
    private final BuildProperties buildProperties;

    public VersionController(BuildProperties buildProperties) {
        this.buildProperties = buildProperties;
    }

    @GetMapping("/version")
    public VersionResponse version() {
        return new VersionResponse(buildProperties.getVersion());
    }

    public record VersionResponse(String version) {
    }
}
