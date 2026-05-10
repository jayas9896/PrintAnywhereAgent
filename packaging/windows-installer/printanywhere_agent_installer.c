#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <wchar.h>

#define IDR_AGENT_ZIP 101

#ifndef AGENT_BUNDLE_NAME
#define AGENT_BUNDLE_NAME L"printanywhere-agent"
#endif

#define INSTALL_ROOT_SUFFIX L"Dhruvanta Systems\\PrintAnywhereAgent"
#define LOCAL_UI_URL L"http://127.0.0.1:43100"
#define BUFFER_CHARS 8192

static void show_message(const wchar_t *title, const wchar_t *message, UINT flags) {
  MessageBoxW(NULL, message, title, flags | MB_SETFOREGROUND);
}

static void show_last_error(const wchar_t *title, const wchar_t *prefix) {
  DWORD error = GetLastError();
  wchar_t system_message[2048] = L"";
  FormatMessageW(
    FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
    NULL,
    error,
    0,
    system_message,
    (DWORD)(sizeof(system_message) / sizeof(system_message[0])),
    NULL
  );

  wchar_t message[BUFFER_CHARS];
  swprintf(message, BUFFER_CHARS, L"%ls\n\nWindows error %lu:\n%ls", prefix, error, system_message);
  show_message(title, message, MB_ICONERROR);
}

static int path_join(wchar_t *out, size_t out_chars, const wchar_t *left, const wchar_t *right) {
  if (!left || !right || wcslen(left) + wcslen(right) + 2 >= out_chars) {
    return 0;
  }

  wcscpy(out, left);
  size_t length = wcslen(out);
  if (length > 0 && out[length - 1] != L'\\' && out[length - 1] != L'/') {
    wcscat(out, L"\\");
  }
  wcscat(out, right);
  return 1;
}

static int ensure_directory(const wchar_t *path) {
  DWORD attrs = GetFileAttributesW(path);
  if (attrs != INVALID_FILE_ATTRIBUTES) {
    return (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
  }

  wchar_t parent[BUFFER_CHARS];
  if (wcslen(path) >= BUFFER_CHARS) {
    return 0;
  }
  wcscpy(parent, path);

  wchar_t *last_slash = wcsrchr(parent, L'\\');
  if (!last_slash) {
    return 0;
  }

  if (last_slash > parent && *(last_slash - 1) == L':') {
    *(last_slash + 1) = L'\0';
  } else {
    *last_slash = L'\0';
  }

  if (wcslen(parent) > 3 && !ensure_directory(parent)) {
    return 0;
  }

  if (CreateDirectoryW(path, NULL)) {
    return 1;
  }

  return GetLastError() == ERROR_ALREADY_EXISTS;
}

static int write_resource_zip(const wchar_t *zip_path) {
  HRSRC resource = FindResourceW(NULL, MAKEINTRESOURCEW(IDR_AGENT_ZIP), RT_RCDATA);
  if (!resource) {
    show_last_error(L"PrintAnywhere Agent Setup", L"The embedded release bundle could not be found.");
    return 0;
  }

  HGLOBAL loaded = LoadResource(NULL, resource);
  DWORD size = SizeofResource(NULL, resource);
  void *data = LockResource(loaded);
  if (!loaded || !size || !data) {
    show_last_error(L"PrintAnywhere Agent Setup", L"The embedded release bundle could not be loaded.");
    return 0;
  }

  HANDLE file = CreateFileW(zip_path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) {
    show_last_error(L"PrintAnywhere Agent Setup", L"The installer could not write the embedded release bundle.");
    return 0;
  }

  DWORD written = 0;
  BOOL ok = WriteFile(file, data, size, &written, NULL);
  CloseHandle(file);

  if (!ok || written != size) {
    show_last_error(L"PrintAnywhere Agent Setup", L"The installer could not finish writing the embedded release bundle.");
    return 0;
  }

  return 1;
}

static void append_ps_escaped(wchar_t *out, size_t out_chars, const wchar_t *value) {
  size_t pos = wcslen(out);
  for (const wchar_t *cursor = value; *cursor && pos + 2 < out_chars; cursor++) {
    if (*cursor == L'`' || *cursor == L'"') {
      out[pos++] = L'`';
    }
    out[pos++] = *cursor;
  }
  out[pos] = L'\0';
}

static int append_literal(wchar_t *out, size_t out_chars, const wchar_t *value) {
  if (wcslen(out) + wcslen(value) + 1 >= out_chars) {
    return 0;
  }
  wcscat(out, value);
  return 1;
}

static int append_assignment(wchar_t *script, size_t script_chars, const wchar_t *name, const wchar_t *value) {
  if (!append_literal(script, script_chars, name) || !append_literal(script, script_chars, L" = \"")) {
    return 0;
  }
  append_ps_escaped(script, script_chars, value);
  return append_literal(script, script_chars, L"\"\r\n");
}

static int write_utf16_file(const wchar_t *path, const wchar_t *content) {
  HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) {
    return 0;
  }

  DWORD written = 0;
  const WORD bom = 0xFEFF;
  BOOL ok = WriteFile(file, &bom, sizeof(bom), &written, NULL);
  if (ok) {
    ok = WriteFile(file, content, (DWORD)(wcslen(content) * sizeof(wchar_t)), &written, NULL);
  }
  CloseHandle(file);
  return ok != 0;
}

static DWORD run_and_wait(const wchar_t *command_line, const wchar_t *working_dir) {
  wchar_t command[BUFFER_CHARS];
  if (wcslen(command_line) >= BUFFER_CHARS) {
    return 1;
  }
  wcscpy(command, command_line);

  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;

  BOOL ok = CreateProcessW(
    NULL,
    command,
    NULL,
    NULL,
    FALSE,
    CREATE_NO_WINDOW,
    NULL,
    working_dir,
    &startup,
    &process
  );

  if (!ok) {
    return GetLastError();
  }

  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return exit_code;
}

static int has_quiet_flag(const wchar_t *command_line) {
  if (!command_line) {
    return 0;
  }
  return wcsstr(command_line, L"/quiet") ||
    wcsstr(command_line, L"/silent") ||
    wcsstr(command_line, L"--quiet") ||
    wcsstr(command_line, L"--silent");
}

static int has_no_launch_flag(const wchar_t *command_line) {
  if (!command_line) {
    return 0;
  }
  return wcsstr(command_line, L"/nolaunch") ||
    wcsstr(command_line, L"--no-launch") ||
    wcsstr(command_line, L"--nolaunch");
}

static void launch_powershell_script(
  const wchar_t *script_path,
  const wchar_t *bundle_dir,
  const wchar_t *data_dir,
  int open_ui
) {
  wchar_t args[BUFFER_CHARS];
  swprintf(
    args,
    BUFFER_CHARS,
    L"-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%ls\" -DataDir \"%ls\" -Port 43100%ls",
    script_path,
    data_dir,
    open_ui ? L" -OpenUi" : L""
  );
  ShellExecuteW(NULL, L"open", L"powershell.exe", args, bundle_dir, SW_HIDE);
}

static void run_scheduled_task(const wchar_t *task_name, const wchar_t *working_dir) {
  wchar_t command[BUFFER_CHARS];
  swprintf(command, BUFFER_CHARS, L"schtasks.exe /Run /TN \"%ls\"", task_name);
  run_and_wait(command, working_dir);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show_command) {
  (void)instance;
  (void)previous;
  (void)show_command;

  int quiet = has_quiet_flag(command_line);
  int no_launch = has_no_launch_flag(command_line);

  wchar_t local_app_data[BUFFER_CHARS];
  DWORD env_length = GetEnvironmentVariableW(L"LOCALAPPDATA", local_app_data, BUFFER_CHARS);
  if (env_length == 0 || env_length >= BUFFER_CHARS) {
    show_message(
      L"PrintAnywhere Agent Setup",
      L"LOCALAPPDATA is not available for this Windows user. The installer cannot choose a safe per-user install folder.",
      MB_ICONERROR
    );
    return 1;
  }

  wchar_t install_root[BUFFER_CHARS];
  wchar_t zip_path[BUFFER_CHARS];
  wchar_t bundle_dir[BUFFER_CHARS];
  wchar_t setup_script[BUFFER_CHARS];
  wchar_t install_cmd[BUFFER_CHARS];
  wchar_t start_cmd[BUFFER_CHARS];
  wchar_t start_script[BUFFER_CHARS];
  wchar_t tray_script[BUFFER_CHARS];
  wchar_t data_dir[BUFFER_CHARS];

  if (
    !path_join(install_root, BUFFER_CHARS, local_app_data, INSTALL_ROOT_SUFFIX) ||
    !path_join(zip_path, BUFFER_CHARS, install_root, AGENT_BUNDLE_NAME L".zip") ||
    !path_join(bundle_dir, BUFFER_CHARS, install_root, AGENT_BUNDLE_NAME) ||
    !path_join(setup_script, BUFFER_CHARS, install_root, L"run-printanywhere-agent-install.ps1") ||
    !path_join(install_cmd, BUFFER_CHARS, bundle_dir, L"install-agent.cmd") ||
    !path_join(start_cmd, BUFFER_CHARS, bundle_dir, L"start-agent.cmd") ||
    !path_join(start_script, BUFFER_CHARS, bundle_dir, L"scripts\\start-agent-background.ps1") ||
    !path_join(tray_script, BUFFER_CHARS, bundle_dir, L"scripts\\agent-tray.ps1") ||
    !path_join(data_dir, BUFFER_CHARS, install_root, L"data")
  ) {
    show_message(L"PrintAnywhere Agent Setup", L"The install path is too long.", MB_ICONERROR);
    return 1;
  }

  if (!ensure_directory(install_root)) {
    show_last_error(L"PrintAnywhere Agent Setup", L"The installer could not create the per-user install folder.");
    return 1;
  }

  if (!write_resource_zip(zip_path)) {
    return 1;
  }

  wchar_t script[BUFFER_CHARS * 2] = L"$ErrorActionPreference = \"Stop\"\r\n";
  append_assignment(script, BUFFER_CHARS * 2, L"$zip", zip_path);
  append_assignment(script, BUFFER_CHARS * 2, L"$installRoot", install_root);
  append_assignment(script, BUFFER_CHARS * 2, L"$bundleDir", bundle_dir);
  append_assignment(script, BUFFER_CHARS * 2, L"$dataDir", data_dir);
  append_literal(script, BUFFER_CHARS * 2, L"New-Item -ItemType Directory -Force -Path $installRoot | Out-Null\r\n");
  append_literal(script, BUFFER_CHARS * 2, L"Expand-Archive -LiteralPath $zip -DestinationPath $installRoot -Force\r\n");
  append_literal(script, BUFFER_CHARS * 2, L"Set-Location $bundleDir\r\n");
  append_literal(script, BUFFER_CHARS * 2, L"$trayProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $commandLine = [string]$_.CommandLine; $_.ProcessId -ne $PID -and -not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine -match \"agent-tray\\.ps1\" -and ($commandLine -match \"PrintAnywhereAgent\" -or $commandLine.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)) }\r\n");
  append_literal(script, BUFFER_CHARS * 2, L"foreach ($process in $trayProcesses) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }\r\n");
  append_literal(script, BUFFER_CHARS * 2, L"$owners = Get-NetTCPConnection -LocalPort 43100 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 -and $_.State -eq \"Listen\" } | Select-Object -ExpandProperty OwningProcess -Unique\r\n");
  append_literal(script, BUFFER_CHARS * 2, L"foreach ($processId in $owners) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }\r\n");
  append_literal(script, BUFFER_CHARS * 2, L"Start-Sleep -Seconds 1\r\n");
  append_literal(script, BUFFER_CHARS * 2, L"& .\\install-agent.cmd -DataDir $dataDir -Port 43100 -RegisterStartupTask -CreateShortcuts\r\n");

  if (!write_utf16_file(setup_script, script)) {
    show_last_error(L"PrintAnywhere Agent Setup", L"The installer could not write its PowerShell setup script.");
    return 1;
  }

  wchar_t powershell_command[BUFFER_CHARS];
  swprintf(
    powershell_command,
    BUFFER_CHARS,
    L"powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%ls\"",
    setup_script
  );

  DWORD install_exit = run_and_wait(powershell_command, install_root);
  if (install_exit != 0) {
    wchar_t message[BUFFER_CHARS];
    swprintf(
      message,
      BUFFER_CHARS,
      L"The release bundle was extracted, but the install script exited with code %lu.\n\nOpen this folder and run install-agent.cmd manually:\n%ls",
      install_exit,
      bundle_dir
    );
    show_message(L"PrintAnywhere Agent Setup", message, MB_ICONERROR);
    ShellExecuteW(NULL, L"open", bundle_dir, NULL, NULL, SW_SHOWNORMAL);
    return (int)install_exit;
  }

  int start_now = IDYES;
  if (!quiet) {
    start_now = MessageBoxW(
      NULL,
      L"PrintAnywhere Agent was installed for this Windows user.\n\nStart the local agent in the background and open the local UI now?",
      L"PrintAnywhere Agent Setup",
      MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND
    );
  }

  if (start_now == IDYES && !no_launch) {
    if (quiet) {
      run_scheduled_task(L"PrintAnywhereAgent", install_root);
      run_scheduled_task(L"PrintAnywhereAgent Tray", install_root);
    } else {
      launch_powershell_script(start_script, bundle_dir, data_dir, 1);
      launch_powershell_script(tray_script, bundle_dir, data_dir, 0);
    }
    Sleep(1500);
  }

  if (quiet) {
    return 0;
  }

  wchar_t success[BUFFER_CHARS];
  swprintf(
    success,
    BUFFER_CHARS,
    L"Installed to:\n%ls\n\nDesktop and Start Menu shortcuts were created with the Dhruvanta icon. The agent is configured to start hidden at Windows sign-in, and the tray icon provides open, refresh, restart, stop, and update actions.",
    bundle_dir
  );
  show_message(L"PrintAnywhere Agent Setup", success, MB_ICONINFORMATION);
  return 0;
}
