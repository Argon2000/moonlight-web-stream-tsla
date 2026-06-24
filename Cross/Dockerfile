ARG CROSS_BASE_IMAGE=scratch
FROM $CROSS_BASE_IMAGE AS base

# -- Overwrite the openssl finder so we just don't do anything (it'll just error out even though we have the lib when defined)
RUN echo "" > $(cmake --system-information | grep CMAKE_ROOT | cut -d'"' -f2)/Modules/FindOpenSSL.cmake

# -- This will enable functionality for cross in the build rs
ENV MOONLIGHT_COMMON_CROSS=1