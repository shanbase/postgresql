#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <stdint.h>
#include <sys/types.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>

static struct passwd fake_passwd;
static struct group fake_group;

static int is_current_uid(uid_t uid) {
  return uid == getuid() || uid == geteuid();
}

static int is_current_gid(gid_t gid) {
  return gid == getgid() || gid == getegid();
}

static const char *login_name(void) {
  const char *name = getenv("PG_UID_COMPAT_NAME");
  return name && *name ? name : "postgres";
}

static int is_login_name(const char *name) {
  return name && strcmp(name, login_name()) == 0;
}

static const char *home_directory(void) {
  const char *home = getenv("HOME");
  return home && *home ? home : "/";
}

static void initialize_passwd(uid_t uid) {
  fake_passwd.pw_name = (char *)login_name();
  fake_passwd.pw_passwd = "x";
  fake_passwd.pw_uid = uid;
  fake_passwd.pw_gid = getegid();
  fake_passwd.pw_gecos = "PostgreSQL";
  fake_passwd.pw_dir = (char *)home_directory();
  fake_passwd.pw_shell = "/bin/sh";
}

static void initialize_group(gid_t gid) {
  static char *members[] = { NULL };
  fake_group.gr_name = (char *)login_name();
  fake_group.gr_passwd = "x";
  fake_group.gr_gid = gid;
  fake_group.gr_mem = members;
}

static int copy_field(char **target, char **cursor, size_t *remaining, const char *value) {
  size_t length = strlen(value) + 1;
  if (length > *remaining) return ERANGE;
  memcpy(*cursor, value, length);
  *target = *cursor;
  *cursor += length;
  *remaining -= length;
  return 0;
}

static int fill_passwd(uid_t uid, struct passwd *pwd, char *buffer, size_t size, struct passwd **result) {
  char *cursor = buffer;
  size_t remaining = size;
  int status;
  status = copy_field(&pwd->pw_name, &cursor, &remaining, login_name());
  if (status) goto fail;
  status = copy_field(&pwd->pw_passwd, &cursor, &remaining, "x");
  if (status) goto fail;
  status = copy_field(&pwd->pw_gecos, &cursor, &remaining, "PostgreSQL");
  if (status) goto fail;
  status = copy_field(&pwd->pw_dir, &cursor, &remaining, home_directory());
  if (status) goto fail;
  status = copy_field(&pwd->pw_shell, &cursor, &remaining, "/bin/sh");
  if (status) goto fail;
  pwd->pw_uid = uid;
  pwd->pw_gid = getegid();
  *result = pwd;
  return 0;
fail:
  *result = NULL;
  return status;
}

static int fill_group(gid_t gid, struct group *group, char *buffer, size_t size, struct group **result) {
  char *cursor = buffer;
  size_t remaining = size;
  int status;
  status = copy_field(&group->gr_name, &cursor, &remaining, login_name());
  if (status) goto fail;
  status = copy_field(&group->gr_passwd, &cursor, &remaining, "x");
  if (status) goto fail;
  uintptr_t aligned = ((uintptr_t)cursor + _Alignof(char *) - 1) & ~((uintptr_t)_Alignof(char *) - 1);
  size_t padding = (size_t)(aligned - (uintptr_t)cursor);
  if (padding + sizeof(char *) > remaining) { status = ERANGE; goto fail; }
  cursor += padding;
  char **members = (char **)cursor;
  members[0] = NULL;
  group->gr_gid = gid;
  group->gr_mem = members;
  *result = group;
  return 0;
fail:
  *result = NULL;
  return status;
}

struct passwd *getpwuid(uid_t uid) {
  static struct passwd *(*real_getpwuid)(uid_t);
  if (!real_getpwuid) real_getpwuid = dlsym(RTLD_NEXT, "getpwuid");
  if (real_getpwuid) {
    struct passwd *entry = real_getpwuid(uid);
    if (entry) return entry;
  }
  if (!is_current_uid(uid)) return NULL;
  initialize_passwd(uid);
  return &fake_passwd;
}

int getpwuid_r(uid_t uid, struct passwd *pwd, char *buffer, size_t size, struct passwd **result) {
  static int (*real_getpwuid_r)(uid_t, struct passwd *, char *, size_t, struct passwd **);
  if (!real_getpwuid_r) real_getpwuid_r = dlsym(RTLD_NEXT, "getpwuid_r");
  if (real_getpwuid_r) {
    int status = real_getpwuid_r(uid, pwd, buffer, size, result);
    if (status == 0 && *result) return 0;
    if (status != 0 && status != ENOENT && status != ESRCH) return status;
  }
  if (!is_current_uid(uid)) {
    *result = NULL;
    return 0;
  }
  return fill_passwd(uid, pwd, buffer, size, result);
}

struct passwd *getpwnam(const char *name) {
  static struct passwd *(*real_getpwnam)(const char *);
  if (!real_getpwnam) real_getpwnam = dlsym(RTLD_NEXT, "getpwnam");
  if (real_getpwnam) {
    struct passwd *entry = real_getpwnam(name);
    if (entry) return entry;
  }
  if (!is_login_name(name)) return NULL;
  initialize_passwd(geteuid());
  return &fake_passwd;
}

int getpwnam_r(const char *name, struct passwd *pwd, char *buffer, size_t size, struct passwd **result) {
  static int (*real_getpwnam_r)(const char *, struct passwd *, char *, size_t, struct passwd **);
  if (!real_getpwnam_r) real_getpwnam_r = dlsym(RTLD_NEXT, "getpwnam_r");
  if (real_getpwnam_r) {
    int status = real_getpwnam_r(name, pwd, buffer, size, result);
    if (status == 0 && *result) return 0;
    if (status != 0 && status != ENOENT && status != ESRCH) return status;
  }
  if (!is_login_name(name)) {
    *result = NULL;
    return 0;
  }
  return fill_passwd(geteuid(), pwd, buffer, size, result);
}

struct group *getgrgid(gid_t gid) {
  static struct group *(*real_getgrgid)(gid_t);
  if (!real_getgrgid) real_getgrgid = dlsym(RTLD_NEXT, "getgrgid");
  if (real_getgrgid) {
    struct group *entry = real_getgrgid(gid);
    if (entry) return entry;
  }
  if (!is_current_gid(gid)) return NULL;
  initialize_group(gid);
  return &fake_group;
}

int getgrgid_r(gid_t gid, struct group *group, char *buffer, size_t size, struct group **result) {
  static int (*real_getgrgid_r)(gid_t, struct group *, char *, size_t, struct group **);
  if (!real_getgrgid_r) real_getgrgid_r = dlsym(RTLD_NEXT, "getgrgid_r");
  if (real_getgrgid_r) {
    int status = real_getgrgid_r(gid, group, buffer, size, result);
    if (status == 0 && *result) return 0;
    if (status != 0 && status != ENOENT && status != ESRCH) return status;
  }
  if (!is_current_gid(gid)) {
    *result = NULL;
    return 0;
  }
  return fill_group(gid, group, buffer, size, result);
}

struct group *getgrnam(const char *name) {
  static struct group *(*real_getgrnam)(const char *);
  if (!real_getgrnam) real_getgrnam = dlsym(RTLD_NEXT, "getgrnam");
  if (real_getgrnam) {
    struct group *entry = real_getgrnam(name);
    if (entry) return entry;
  }
  if (!is_login_name(name)) return NULL;
  initialize_group(getegid());
  return &fake_group;
}

int getgrnam_r(const char *name, struct group *group, char *buffer, size_t size, struct group **result) {
  static int (*real_getgrnam_r)(const char *, struct group *, char *, size_t, struct group **);
  if (!real_getgrnam_r) real_getgrnam_r = dlsym(RTLD_NEXT, "getgrnam_r");
  if (real_getgrnam_r) {
    int status = real_getgrnam_r(name, group, buffer, size, result);
    if (status == 0 && *result) return 0;
    if (status != 0 && status != ENOENT && status != ESRCH) return status;
  }
  if (!is_login_name(name)) {
    *result = NULL;
    return 0;
  }
  return fill_group(getegid(), group, buffer, size, result);
}
