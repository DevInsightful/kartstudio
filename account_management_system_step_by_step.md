# Account Management System — Step-by-Step Specification

## 1. Goal

Build a reusable account-management subsystem for the desktop automation application.

It must support:

- Single account creation
- Bulk credential import
- CSV/XLSX import
- Import validation and duplicate detection
- Secure credential storage
- Dedicated browser profile per account
- Session/login management
- Account selection
- Categories
- Per-account tags
- Per-account notes
- Bulk category assignment
- Bulk tag operations
- Bulk note operations
- Search and filtering
- Bulk account checks
- Trash/restore
- Activity/audit history
- Browser concurrency from 1 to 20
- Failure isolation

> **Security:** Only support accounts the user is authorized to operate. Passwords must be encrypted at rest, never exposed in normal UI tables, never written to logs, and never exported accidentally. Do not implement cookie/token extraction or session theft.

---

# 2. Core Data Model

Keep these concepts separate:

```text
Account
 ├── CredentialRecord
 ├── BrowserProfile
 ├── Session
 ├── Category
 ├── Tags
 ├── Notes
 └── Activity
```

An account is not the same thing as its browser profile or session.

Recommended relationship:

```text
Account
 ├── 0..1 CredentialRecord
 ├── 1 BrowserProfile
 ├── 0..1 Session
 ├── 0..1 primary Category
 ├── many Tags
 └── account-specific Notes
```

---

# 3. Account Lifecycle

Use explicit states:

```text
IMPORTED
   ↓
NOT_CONFIGURED
   ↓
LOGIN_REQUIRED
   ↓
CHECKING
   ↓
ACTIVE
```

Possible states:

```text
ACTIVE
LOGIN_REQUIRED
SESSION_EXPIRED
LOGIN_FAILED
CHECKING
RUNNING
PAUSED
RESTRICTED
DISABLED
ERROR
TRASHED
```

Keep account status and session status separate.

Example:

```text
Account Status: ACTIVE
Session Status: LOGIN_REQUIRED
```

---

# 4. Account Identity

Every account receives an application-generated ID:

```text
ACC-000001
ACC-000002
ACC-000003
```

After an authorized login/session check, store permitted platform identity information:

```text
Internal ID: ACC-000001
Platform UID: 1000xxxxxxxx
Display Name: John Smith
Profile URL: https://www.facebook.com/...
```

The platform UID must not be the primary database key.

---

# 5. Bulk Credential Import

## 5.1 Import Entry Point

```text
Accounts
  ↓
Import Accounts
```

Initial supported formats:

- CSV
- XLSX
- TXT with a documented delimiter

CSV should be implemented first.

Example structure:

```csv
name,username,password,category,tags,notes
John Smith,john@example.com,REDACTED,UK Marketing,"UK,Furniture","Primary account"
Account Two,user2@example.com,REDACTED,Testing,"Test","Testing account"
Account Three,user3@example.com,REDACTED,,,"No category yet"
```

Never put real credentials into source code, Git, screenshots, issue trackers, or logs.

---

# 6. Import Wizard

Use a six-step wizard:

```text
1. Select File
2. Detect / Map Columns
3. Validate
4. Preview
5. Import
6. Result
```

## Step 1 — Select File

```text
Import Accounts

[Choose CSV / XLSX]

[Next]
```

## Step 2 — Column Mapping

Example:

```text
name      → Display Name
username  → Username
password  → Password
category  → Category
tags      → Tags
notes     → Notes
```

Allow manual mapping when source column names differ.

## Step 3 — Validation

Example:

```text
Row 1   ✓ Valid
Row 2   ✓ Valid
Row 3   ✗ Missing username
Row 4   ✗ Missing password
Row 5   ⚠ Duplicate
```

Validate:

- Required fields
- Username format
- Non-empty password when credential import is selected
- Duplicate accounts
- Category values
- Tags
- Notes
- File structure

A bad row must not stop the entire import.

## Step 4 — Preview

Display safe information only:

```text
Row | Account | Category | Tags | Validation
1   | John    | UK        | UK,Furniture | ✓
2   | Mike    | Testing   | Test         | ✓
```

Passwords must remain masked.

## Step 5 — Import

User clicks:

```text
[Import Valid Accounts]
```

The app creates account records and securely stores credentials.

## Step 6 — Result

Example:

```text
Import Complete

Total rows:       100
Imported:          94
Duplicates:         4
Invalid:            2
```

The validation report must never contain passwords.

---

# 7. Duplicate Handling

When an account already exists:

```text
Duplicate Account

Existing: ACC-000021
Imported: john@example.com

(•) Skip
( ) Update existing
( ) Ask per duplicate
```

Recommended default:

```text
Skip
```

---

# 8. Credential Security

Do not store plaintext passwords in the normal Account table.

Use:

```text
Account
---------
id
displayName
platformUid
profileUrl
categoryId
status
createdAt
updatedAt

CredentialRecord
----------------
id
accountId
username
encryptedPassword
createdAt
updatedAt
```

Use operating-system protected key storage where practical, such as Windows Credential Manager / protected local storage.

Never:

```text
console.log(password)
logger.info(password)
store password in job history
include password in screenshots
include password in error messages
commit password to Git
```

---

# 9. Add Account Manually

Support:

```text
Accounts
  ↓
+ Add Account
```

Fields:

```text
Display Name
Username (optional)
Category
Tags
Notes
```

Then:

```text
[Create Account]
```

The user can later connect the account through its dedicated browser profile.

---

# 10. Dedicated Browser Profile

Every account gets its own persistent browser profile.

Example:

```text
ACC-000001 → BP-000001
ACC-000002 → BP-000002
ACC-000003 → BP-000003
```

Conceptually:

```text
profiles/
├── ACC-000001/
├── ACC-000002/
└── ACC-000003/
```

Do not reuse one persistent profile between different accounts.

Do not expose raw cookies/tokens in the UI.

---

# 11. Account Connection Workflow

```text
Account
  ↓
Open Browser Profile
  ↓
Open Facebook
  ↓
User completes authorized login if required
  ↓
Application checks permitted identity
  ↓
Verify expected account
  ↓
Session = ACTIVE
```

If the detected account is different:

```text
Expected: Account A
Detected: Account B

[Close Browser]
```

Do not automatically attach the wrong session.

---

# 12. Main Account Table

Recommended UI:

```text
┌─────────────────────────────────────────────────────────┐
│ Accounts                                                │
├─────────────────────────────────────────────────────────┤
│ Search accounts...                                      │
│                                                         │
│ [Import] [Add Account] [Check] [Actions ▼]             │
├───┬──────────────┬────────────┬────────┬───────────────┤
│ □ │ Account      │ Category   │ Tags   │ Session/State │
├───┼──────────────┼────────────┼────────┼───────────────┤
│ □ │ John Smith   │ UK         │ Sofa   │ 🟢 Active     │
│ □ │ Account 02   │ Marketing  │ UK     │ 🟢 Active     │
│ □ │ Account 03   │ Testing    │ Test   │ 🟡 Login     │
└───┴──────────────┴────────────┴────────┴───────────────┘
```

---

# 13. Account Selection

Support:

### Single

```text
☑ Account 01
```

### Multiple

```text
☑ Account 01
☑ Account 02
☑ Account 05
```

### Select all visible

```text
☑ Select All
```

### Select all matching filters

Example:

```text
Category = UK

[Select all 34 matching accounts]
```

Selection must use account IDs, not table row indexes, so it survives sorting, filtering, pagination, and refreshes.

---

# 14. Selection Toolbar

When one or more accounts are selected:

```text
4 accounts selected

[Add Category]
[Add Tags]
[Remove Tags]
[Add Notes]
[Replace Notes]
[Check]
[Open]
[Connect/Login]
[Trash]
[More ▼]
```

---

# 15. Categories

A category is the primary organizational group.

Example:

```text
UK Marketing
US Marketing
Furniture
Testing
Clients
```

Each account has at most one primary category.

Tags are separate and can be many per account.

---

# 16. Create Category

```text
Accounts
  ↓
Categories
  ↓
+ Create Category
```

Form:

```text
Category Name:
[UK Marketing]

Description:
[Accounts used for UK marketing]

[Create]
```

Database:

```text
Category
---------
id
workspaceId
name
description
createdAt
updatedAt
```

---

# 17. Assign Selected Accounts to a Category

Select:

```text
☑ Account 01
☑ Account 02
☑ Account 03
☑ Account 04
```

Click:

```text
[Add Category]
```

Dialog:

```text
Assign Category

Category:
[UK Marketing ▼]

4 selected
3 have no category
1 already belongs to another category

[ ] Replace existing category

[Cancel] [Apply]
```

Never silently overwrite an existing category.

If replacement is enabled:

```text
Testing
   ↓
UK Marketing
```

show a confirmation.

---

# 18. Remove Category

Selected accounts:

```text
[Remove Category]
```

Confirmation:

```text
Remove category from 12 accounts?
```

This only clears the category relationship.

The accounts remain.

---

# 19. Tags

Tags are account-level labels.

One account can have many:

```text
[UK] [Furniture] [Primary] [Verified]
```

Another can have:

```text
[US] [Secondary]
```

Database relationship:

```text
Account
   ↕
AccountTag
   ↕
Tag
```

---

# 20. Create Tag

Either:

```text
Accounts → Tags → Create Tag
```

or directly from an account:

```text
[+ Add Tag]
```

---

# 21. Add Tags to One Account

```text
John Smith

Tags:
[UK] [Primary]

[+ Add Tag]

Select:
Furniture
Verified
```

Result:

```text
[UK] [Primary] [Furniture] [Verified]
```

---

# 22. Add Tags to Multiple Accounts

Select:

```text
☑ Account 01
☑ Account 02
☑ Account 03
```

Click:

```text
[Add Tags]
```

Select:

```text
UK
Furniture
Primary
```

Existing tags remain.

---

# 23. Remove Tags

Support:

```text
[Remove Tags]
```

Example:

```text
Remove:
☑ Test
☑ Temporary
```

Only selected tags are removed.

---

# 24. Replace Tags

Provide a separate explicit action:

```text
[Replace Tags]
```

Example:

```text
Current:
UK, Old

Replace with:
UK, Furniture
```

This action must require confirmation because it removes existing tags.

---

# 25. Notes

Notes belong to a specific account.

Example:

```text
Account: John Smith

Notes:
Primary UK marketing account.
Used for furniture work.
```

Notes are not global.

---

# 26. Edit Notes for One Account

Account drawer:

```text
Notes

┌─────────────────────────────┐
│ Primary UK marketing       │
│ account.                   │
│                            │
│ Used for furniture work.   │
└─────────────────────────────┘

[Save]
```

---

# 27. Add Notes to Multiple Accounts

Select:

```text
☑ Account 01
☑ Account 02
☑ Account 03
```

Click:

```text
[Add Notes]
```

Dialog:

```text
Add Note

[Imported during October campaign setup.]

Mode:
(•) Append
( ) Replace

[Cancel] [Apply]
```

Default to Append so existing account-specific notes are not destroyed.

---

# 28. Bulk Note Behavior

Append:

```text
Existing note

+

New note
```

Replace:

```text
Existing note
   ↓
New note
```

Replacement requires confirmation.

---

# 29. Account Detail Drawer

Clicking an account opens:

```text
John Smith

Identity
Internal ID: ACC-000001
Platform UID: 1000xxxx
Profile URL: ...

Organization
Category: UK Marketing
Tags: UK, Furniture, Primary

Session
🟢 Logged In
Last Checked: 20:32

Notes
Primary UK marketing account.

Browser Profile
BP-000001

Activity
Last Used: 20:31
Successful Jobs: 42
Failed Jobs: 2

[Open Browser]
[Check]
[Connect/Login]
[Edit]
[Trash]
```

Never display stored passwords here.

---

# 30. Bulk Browser Opening

If 20 accounts are selected and concurrency is 2:

```text
Queue:
ACC-01
ACC-02
...
ACC-20

Worker 1 → ACC-01
Worker 2 → ACC-02

ACC-01 finishes
Worker 1 → ACC-03

ACC-02 finishes
Worker 2 → ACC-04
```

Continue until the queue is empty.

Concurrency is a maximum number of simultaneous workers, not a batch size.

---

# 31. Account Check

Workflow:

```text
Account
  ↓
Browser Profile
  ↓
Launch
  ↓
Open authorized session
  ↓
Check identity/session state
  ↓
Save result
  ↓
Close/release
```

Possible results:

```text
ACTIVE
LOGIN_REQUIRED
SESSION_EXPIRED
LOGIN_FAILED
RESTRICTED
ERROR
```

One failed account must not stop other accounts.

---

# 32. Login Manager

Create:

```text
Accounts
  ↓
Login Manager
```

Show:

```text
Login Required: 12
Session Expired: 4
Active: 84
```

User selects accounts and chooses:

```text
Concurrency:
[2]

[Start Login Session]
```

The application processes up to two browser profiles at a time.

---

# 33. Session Model

```text
Session
-------
id
accountId
status
lastCheckedAt
lastAuthenticatedAt
lastError
```

Possible states:

```text
UNKNOWN
ACTIVE
LOGIN_REQUIRED
EXPIRED
ERROR
```

Do not store raw authentication tokens/cookies in ordinary account records.

---

# 34. Account Activity

Example:

```text
20:32 Session checked — Active
20:20 Browser opened
19:50 Publishing job completed
18:40 Category changed
18:30 Tag added: Furniture
18:20 Note updated
```

Never log passwords or authentication secrets.

---

# 35. Audit Events

Record important changes:

```text
ACCOUNT_CREATED
ACCOUNT_IMPORTED
ACCOUNT_UPDATED
CATEGORY_ASSIGNED
CATEGORY_REMOVED
TAG_ADDED
TAG_REMOVED
NOTE_UPDATED
BROWSER_PROFILE_CREATED
SESSION_CHECKED
SESSION_EXPIRED
ACCOUNT_TRASHED
ACCOUNT_RESTORED
```

Example:

```text
CATEGORY_ASSIGNED
Account: ACC-000021
Old: Testing
New: UK Marketing
Time: 2026-10-06 20:32
```

---

# 36. Trash and Restore

Use soft deletion first:

```text
Active
  ↓
Trash
  ↓
Permanent Delete
```

Set:

```text
deletedAt = timestamp
```

Restore:

```text
deletedAt = null
```

Permanent deletion must explicitly confirm removal of:

- Account record
- Category relationship
- Tag relationships
- Notes
- Activity history
- Browser profile
- Credential material

---

# 37. Search and Filters

Search:

```text
Internal ID
Display Name
Username
Platform UID
Profile URL
Category
Tag
Status
```

Filters:

```text
Category
Tags
Account Status
Session Status
Has Notes
Has Credentials
Last Checked
Last Used
```

Allow combined filters.

---

# 38. Saved Views

Allow saved filters such as:

```text
UK Active
US Furniture
Login Required
Primary Accounts
Testing Accounts
```

Store filter criteria, not duplicated account records.

---

# 39. Bulk Operation Framework

Every bulk action should use the same architecture:

```text
Selected Accounts
      ↓
BulkOperationManager
      ↓
Create Operation
      ↓
Create Operation Items
      ↓
Process
      ↓
Success / Failed / Skipped
      ↓
Summary
```

Example:

```text
ADD_TAG

Selected: 50
Success: 48
Skipped: 1
Failed: 1
```

A failed account must not fail the whole batch.

---

# 40. Pause / Resume / Cancel

Bulk operations must support:

```text
[Pause]
[Resume]
[Cancel]
```

Pause:

```text
Finish current safe operation.
Do not start new tasks.
```

Resume:

```text
Continue pending tasks.
```

Cancel:

```text
Stop new tasks.
Perform safe cleanup on active tasks.
Mark remaining tasks CANCELLED.
```

---

# 41. Database Schema

Recommended Prisma-style models:

```text
Workspace
---------
id
name
createdAt
updatedAt

Account
-------
id
workspaceId
internalCode
platform
platformUid
displayName
username
profileUrl
categoryId
status
notes
createdAt
updatedAt
deletedAt

CredentialRecord
----------------
id
accountId
username
encryptedPassword
createdAt
updatedAt

BrowserProfile
--------------
id
accountId
profilePath
status
createdAt
lastStartedAt
lastClosedAt

Category
--------
id
workspaceId
name
description
createdAt
updatedAt

Tag
---
id
workspaceId
name
createdAt
updatedAt

AccountTag
----------
accountId
tagId

Session
-------
id
accountId
status
lastCheckedAt
lastAuthenticatedAt
lastError

AccountActivity
---------------
id
accountId
type
message
createdAt

BulkOperation
-------------
id
workspaceId
type
status
total
successCount
failedCount
skippedCount
createdAt
completedAt

BulkOperationItem
-----------------
id
bulkOperationId
accountId
status
error
createdAt
completedAt
```

---

# 42. Service Architecture

Create separate services.

## AccountManager

```text
createAccount()
updateAccount()
trashAccount()
restoreAccount()
getAccount()
listAccounts()
searchAccounts()
filterAccounts()
bulkUpdateAccounts()
```

## CategoryManager

```text
createCategory()
renameCategory()
deleteCategory()
assignAccounts()
removeAccounts()
```

## TagManager

```text
createTag()
renameTag()
deleteTag()
addTagsToAccounts()
removeTagsFromAccounts()
replaceAccountTags()
```

## NotesManager

```text
getNotes()
setNotes()
appendNotes()
replaceNotes()
bulkAppendNotes()
bulkReplaceNotes()
```

## SessionManager

```text
checkSession()
connectAccount()
markLoginRequired()
markSessionExpired()
markSessionActive()
```

## BrowserProfileManager

```text
createProfile()
openProfile()
closeProfile()
deleteProfile()
getProfile()
```

No browser automation logic should be placed directly in the React UI.

---

# 43. Account Import Architecture

Use:

```text
React UI
   ↓
Electron IPC
   ↓
Account Import Service
   ↓
Validation Service
   ↓
Credential Vault
   ↓
Database
```

The renderer should not directly write sensitive credentials.

---

# 44. Complete Example — Import 100 Accounts

User imports:

```text
100 rows
```

System:

```text
94 valid
4 duplicate
2 invalid
```

User clicks:

```text
Import 94
```

System creates:

```text
94 Account records
94 BrowserProfile records
94 secure credential records
```

Then:

```text
94 imported
94 not checked
```

---

# 45. Complete Example — Organize Accounts

User filters:

```text
Category = None
```

Selects all 94.

Creates:

```text
UK Marketing
```

Applies:

```text
94 → UK Marketing
```

Then:

```text
[Add Tags]
UK
Furniture
Primary
```

Then:

```text
[Add Notes]
Imported during October campaign setup.
Mode: Append
```

Every selected account receives the tag and note while retaining its own existing data.

---

# 46. Complete Example — Modify One Account

Open ACC-000021:

```text
Category:
UK Marketing → Primary UK

Tags:
UK, Furniture, Primary

Notes:
Primary account for UK furniture campaign.
```

Only that account changes.

---

# 47. Complete Example — Move Accounts

Select 20 accounts:

```text
[Move Category]
US Marketing
```

Show:

```text
20 selected
12 currently have another category
8 have no category
```

Require confirmation before replacing the 12 existing categories.

---

# 48. Complete Example — Check 20 Accounts

Set:

```text
Selected: 20
Concurrency: 2
```

Workers:

```text
W1 → ACC-01
W2 → ACC-02

W1 → ACC-03
W2 → ACC-04
...
```

Final:

```text
Active: 16
Login Required: 2
Session Expired: 1
Error: 1
```

---

# 49. Integration With Later Automation

The account system must remain reusable.

Do not create separate account databases for:

- Page creation
- Publishing
- Comments
- Stories
- Scheduling
- Campaigns

Instead:

```text
Account Manager
      ↓
Automation Job Manager
      ↓
Job Task
      ↓
Browser Worker
```

Example:

```text
Account ACC-001
   ↓
Page Creation Task TASK-1001
   ↓
Worker W-02
```

The same account can later be used by publishing and campaign workflows.

---

# 50. Exact Implementation Order

## Phase 1 — Database

1. Workspace
2. Account
3. CredentialRecord
4. Category
5. Tag
6. AccountTag
7. BrowserProfile
8. Session
9. AccountActivity
10. BulkOperation
11. BulkOperationItem

**Test migrations before continuing.**

## Phase 2 — Account CRUD

12. Create
13. Read
14. Update
15. Trash
16. Restore
17. Permanent delete

**Test CRUD before continuing.**

## Phase 3 — Bulk Import

18. CSV upload
19. XLSX upload
20. File validation
21. Column detection
22. Column mapping
23. Row validation
24. Duplicate detection
25. Preview
26. Secure credential storage
27. Import
28. Import report

Test:

```text
1 account
10 accounts
100 accounts
duplicates
invalid rows
missing fields
```

## Phase 4 — Categories

29. Create category
30. Rename
31. Delete
32. Assign one account
33. Assign multiple accounts
34. Remove category
35. Move accounts

## Phase 5 — Tags

36. Create tag
37. Rename
38. Delete
39. Add to one
40. Add to many
41. Remove
42. Remove from many
43. Replace

## Phase 6 — Notes

44. Add to one
45. Edit one
46. Append to many
47. Replace many
48. Verify account isolation

## Phase 7 — Selection

49. Single selection
50. Multi-selection
51. Select all
52. Select all filtered
53. Selection across pagination
54. Clear selection

## Phase 8 — Browser Profiles

55. Create profile
56. Link profile
57. Open
58. Close
59. Profile status
60. Cleanup

## Phase 9 — Sessions

61. Session check
62. Login-required state
63. Session-expired state
64. Authorized identity verification
65. Login Manager

## Phase 10 — Concurrency

66. Worker pool
67. Concurrency 1
68. Concurrency 2
69. Concurrency 5
70. Concurrency 10
71. Concurrency 20
72. Failure isolation
73. Pause
74. Resume
75. Cancel

## Phase 11 — Bulk Account Operations

76. Bulk check
77. Bulk browser open
78. Bulk connect/login
79. Bulk category
80. Bulk tags
81. Bulk notes
82. Bulk trash

## Phase 12 — Search and Filtering

83. Search
84. Category filter
85. Tag filter
86. Session filter
87. Status filter
88. Combined filters
89. Saved views

## Phase 13 — Activity

90. Account activity
91. Bulk operation history
92. Error history
93. Audit events
94. Operation summaries

---

# 51. Definition of Done

## Import

- [ ] Single account creation
- [ ] CSV import
- [ ] XLSX import
- [ ] Column mapping
- [ ] Validation
- [ ] Duplicate handling
- [ ] Preview
- [ ] Import report
- [ ] Encrypted credential storage

## Organization

- [ ] Categories
- [ ] Bulk category assignment
- [ ] Category removal
- [ ] Multiple tags per account
- [ ] Bulk tag operations
- [ ] Per-account notes
- [ ] Bulk note operations

## Account Management

- [ ] Search
- [ ] Filtering
- [ ] Selection
- [ ] Bulk actions
- [ ] Account drawer
- [ ] Activity
- [ ] Trash
- [ ] Restore
- [ ] Permanent deletion

## Browser

- [ ] Dedicated profile
- [ ] Profile/account relationship
- [ ] Session state
- [ ] Login Manager
- [ ] Identity verification
- [ ] Concurrency 1–20
- [ ] Failure isolation

## Security

- [ ] Passwords encrypted
- [ ] No passwords in logs
- [ ] No passwords in screenshots
- [ ] No credentials in Git
- [ ] No raw cookie/token extraction
- [ ] Secure credential deletion
- [ ] Sensitive operations restricted to the local application

---

# 52. Final Architecture

```text
                    ACCOUNT SYSTEM
                          │
          ┌───────────────┴────────────────┐
          │                                │
       Add One                         Bulk Import
          │                                │
          └───────────────┬────────────────┘
                          ↓
                    Validation
                          ↓
                  Duplicate Detection
                          ↓
                    Secure Storage
                          ↓
                    Account Records
                          │
             ┌────────────┼─────────────┐
             ↓            ↓             ↓
         Category       Tags          Notes
             │            │             │
             └────────────┼─────────────┘
                          ↓
                  Browser Profile
                          ↓
                    Session Manager
                          ↓
                  Browser Worker Pool
                          ↓
                  Automation Job Manager
                          ↓
           Page Creation / Publishing / Campaigns
```

The key rule is:

**Account ≠ credentials ≠ browser profile ≠ session ≠ automation job.**

This separation allows the same accounts to be safely reused across the entire application.
