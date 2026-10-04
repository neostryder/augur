# A clean Arch with the packaging tools and a non-root builder, for validate.sh. CI builds it; locally the rpgm-validate/arch image does the same job.
FROM archlinux:latest
RUN pacman -Syu --noconfirm --needed base-devel namcap \
    && useradd -m builder
