Aces Lair Terminal Commands
===========================

This file collects every terminal command that `aces-lair-99.html` understands, so you can reference them without digging through the client-side script.

1. `Aces-admin-command "username" -banned`  
   - Sends a request to `/api/admin/users/ban` with the quoted full name. Use when you want to ban an operative while preserving the more formal console syntax.

2. `Aces-admin-command "username" -unban`  
   - Sends a request to `/api/admin/users/unban` with the quoted full name. Mirrors the ban command but restores access.

3. `ban "username"`  
   - Convenience alias for the `-banned` flag above; the script strips the quotes and calls `banUser(username)`.

4. `unban "username"`  
   - Convenience alias for the `-unban` flag that calls `unbanUser(username)`.

5. `users` or `list-users`  
   - Fetches `/api/admin/users`, prints counts, and lists each user with their role, email, and `BANNED`/`ACTIVE` status markers.

6. `admins` or `list-admins`  
   - Calls `/api/console/admins` and logs the saved console identities.

7. `online` or `online-admins`  
   - Lists the usernames currently tracked by the socket connection; no network round-trip is required since the list sits in `onlineConsoleAdmins`.

8. `whoami`  
   - Prints the currently authenticated console identity (the value returned by `/api/console/login` and stored in `currentUser`).

9. `status`  
   - Shows the current time, the browser's network status, whether the socket is connected, the logged-in identity (or `UNIDENTIFIED`), and how many admins are online.

10. `echo "message"`  
    - Echoes the literal string you provide (quotes are stripped) so you can spice up the terminal output for debugging or aesthetics.

11. `reload-users` or `sync-users`  
    - Re-runs `loadUsers()` so that the user matrix panel refreshes immediately. Useful after firing ban/unban without waiting for a periodic refresh.

12. `clear`  
    - Erases every log line from the terminal viewport (`serverLogs.innerHTML = ""`).

13. `help`  
    - Reprints the command list inside the terminal, so you can rediscover any alias you forgot.

If you add new terminal commands, please update this file so the reference stays accurate.
