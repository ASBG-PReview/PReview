package com.preview.api.controller;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

class EnvironmentControllerTest {

    /** k8s에서 환경변수를 넣어준 상황을 흉내낸다. */
    @Nested
    @SpringBootTest(properties = {
            "PR_NUMBER=12",
            "COMMIT_SHA=a1b2c3d",
            "NAMESPACE=preview-pr-12"
    })
    @AutoConfigureMockMvc
    class 환경변수가_있을때 {

        @Autowired
        private MockMvc mockMvc;

        @Test
        void 환경정보를_반환한다() throws Exception {
            mockMvc.perform(get("/environment"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.prNumber").value("12"))
                    .andExpect(jsonPath("$.commitSha").value("a1b2c3d"))
                    .andExpect(jsonPath("$.namespace").value("preview-pr-12"));
        }
    }

    /** 로컬에서 환경변수 없이 실행한 상황. 기본값이 나와야 한다. */
    @Nested
    @SpringBootTest
    @AutoConfigureMockMvc
    class 환경변수가_없을때 {

        @Autowired
        private MockMvc mockMvc;

        @Test
        void 기본값을_반환한다() throws Exception {
            mockMvc.perform(get("/environment"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.prNumber").value("local"))
                    .andExpect(jsonPath("$.commitSha").value("unknown"))
                    .andExpect(jsonPath("$.namespace").value("local"));
        }
    }
}
