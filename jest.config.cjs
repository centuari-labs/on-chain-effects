module.exports = {
    testEnvironment: "node",
    testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"],
    transform: {
        "^.+\\.ts$": [
            "ts-jest",
            {
                useESM: true,
                tsconfig: {
                    module: "esnext",
                    moduleResolution: "bundler",
                    target: "ES2022",
                    strict: true,
                    esModuleInterop: true,
                },
            },
        ],
    },
    extensionsToTreatAsEsm: [".ts"],
    moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1",
    },
};
