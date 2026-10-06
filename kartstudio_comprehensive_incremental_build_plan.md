# KartStudio-Like Browser Automation Platform
## Comprehensive Incremental Build & Test Plan

**Build strategy:** One feature at a time → implement → test → fix → approve → move to the next feature.

**Primary principle:**

> Do not build the whole system at once. Every step must produce a working, testable feature before the next step begins.

---

# 1. Product Understanding

We are building a desktop/browser-automation application inspired by the workflow observed in KartStudio.

The application is responsible for:

- Managing Facebook account records
- Managing page information
- Managing page creation data
- Managing locally stored content
- Organizing content into folders/categories/presets
- Creating automation jobs
- Launching browser sessions
- Running scripted browser tasks
- Controlling browser concurrency
- Processing accounts/pages in batches
- Detecting success/failure
- Recording logs and results
- Retrying failed tasks
- Publishing user-provided content
- Scheduling automation
- Showing progress and history

The user provides the actual assets and information.

The application does **not** need to generate the user's videos/content.

The user's workflow is:

```text
Create Content Externally
        ↓
Organize Files
        ↓
Prepare Account/Page Data
        ↓
Import Into Application
        ↓
Configure Automation
        ↓
Select Browser Concurrency
        ↓
Start Job
        ↓
Browser Automation
        ↓
Monitor Progress
        ↓
Review Results
```

---

# 2. Critical Architecture Decision

This is a **browser automation application**, not an API-first publishing application.

The central execution layer is:

```text
Application UI
      ↓
Job Manager
      ↓
Automation Queue
      ↓
Browser Pool
      ↓
Browser Workers
      ↓
Scripted Browser Actions
      ↓
Result Detection
      ↓
Job Result
```

Where supported, operations should use legitimate platform functionality and authorized accounts. The system must not include mechanisms intended to bypass platform security, verification, anti-abuse systems, or enforcement.

---

# 3. Browser Concurrency Requirement

Browser concurrency is a user-configurable setting.

The user can select:

```text
1
2
3
4
5
...
20
```

Maximum:

```text
20 browser profiles/sessions concurrently
```

This is **not** a fixed value.

If the user selects:

```text
Concurrency = 2
```

and has 20 tasks:

```text
Batch 1 → Task 1 + Task 2
Batch 2 → Task 3 + Task 4
Batch 3 → Task 5 + Task 6
...
Batch 10 → Task 19 + Task 20
```

If the user selects:

```text
Concurrency = 20
```

then up to 20 tasks may run simultaneously, subject to machine capacity and configured safeguards.

The application must never exceed the selected concurrency.

---

# 4. Example: Create 20 Pages

User provides:

```text
20 accounts

20 page names
20 bios
20 profile pictures
20 cover pictures

Pages per account = 1

Browser concurrency = 2
```

The system creates a job containing 20 tasks.

Execution:

```text
Worker 1 → Account 01 → Page 01
Worker 2 → Account 02 → Page 02
```

When both finish:

```text
Worker 1 → Account 03 → Page 03
Worker 2 → Account 04 → Page 04
```

Continue until:

```text
Account 19 → Page 19
Account 20 → Page 20
```

Each task has an independent result:

```text
SUCCESS
FAILED
TIMEOUT
CANCELLED
SKIPPED
```

A failure in one task must not automatically destroy the entire batch.

---

# 5. Development Method

Every feature follows this exact lifecycle:

```text
STEP
 ↓
Understand requirements
 ↓
Design
 ↓
Implement
 ↓
Run locally
 ↓
Manual test
 ↓
Automated test where appropriate
 ↓
Fix problems
 ↓
Acceptance test
 ↓
User approval
 ↓
Move to next STEP
```

We should never start Step 10 while Step 9 is broken.

---

# 6. Recommended Technology Stack

## Desktop Application

Recommended:

```text
Electron
+
React
+
TypeScript
```

Alternative:

```text
Tauri
+
React
+
TypeScript
```

For this type of application, Electron is a practical initial choice because browser automation, filesystem operations, background processes, and desktop UI integration are straightforward.

---

## Frontend

```text
React
TypeScript
Tailwind CSS
shadcn/ui
React Router
TanStack Query
Zustand
React Hook Form
Zod
```

---

## Browser Automation

Recommended:

```text
Playwright
```

Browser automation should be isolated from the UI.

Architecture:

```text
Renderer
   ↓
Electron Main Process
   ↓
Automation Service
   ↓
Playwright
```

Do not execute unrestricted browser automation directly inside React components.

---

## Local Database

Recommended:

```text
SQLite
+
Prisma
```

Reason:

The initial application is desktop-first and should work locally without requiring a remote PostgreSQL server.

Later, if the product becomes a multi-user/cloud platform:

```text
PostgreSQL
```

can replace or complement the local database.

---

## Background Processing

Use a local job manager.

Initial implementation:

```text
Electron Main Process
+
Worker Manager
+
Job Queue
```

If the system becomes large:

```text
Redis
+
Dedicated Worker Service
```

can be introduced later.

---

## File Storage

Initially:

```text
Local filesystem
```

Later:

```text
S3-compatible object storage
```

---

# 7. Suggested Project Architecture

```text
kartstudio-clone/
│
├── apps/
│   ├── desktop/
│   │   ├── electron/
│   │   ├── renderer/
│   │   └── preload/
│   │
│   └── automation/
│
├── packages/
│   ├── database/
│   ├── shared/
│   ├── validation/
│   ├── automation-core/
│   └── ui/
│
├── prisma/
│
├── tests/
│
└── docs/
```

---

# 8. Development Steps

The following steps are deliberately ordered by dependency.

---

# STEP 01 — Project Foundation

## Description

Create the initial desktop application with React, TypeScript, Electron, and a clean development structure.

The application must start successfully and display a basic dashboard shell.

Implement:

- Electron main process
- React renderer
- Preload layer
- TypeScript configuration
- Development scripts
- Production build configuration
- Basic routing
- Basic layout
- Error boundary
- Environment configuration
- Logging foundation

Initial UI:

```text
┌─────────────────────────────────────────────┐
│ Logo                              Settings  │
├──────────────┬──────────────────────────────┤
│ Dashboard    │                              │
│ Accounts     │        Dashboard             │
│ Pages        │                              │
│ Content      │        Coming Soon           │
│ Automation   │                              │
│ Jobs         │                              │
│ Settings     │                              │
└──────────────┴──────────────────────────────┘
```

## Test

- Application launches.
- Window opens.
- React renders.
- Navigation works.
- Application can be closed normally.
- Development reload works.
- Production build can be generated.

## Acceptance

Do not continue until the desktop application launches reliably.

---

# STEP 02 — Application Shell & Navigation

## Description

Build the complete navigation shell that will contain all future modules.

Sidebar:

```text
Dashboard

Accounts
Pages
Groups

Campaigns

Content
├── Library
├── Categories
└── Presets

Publishing
├── Calendar
├── Scheduled
└── Published

Automation
├── Jobs
└── Activity

Settings
```

Implement:

- Collapsible sidebar
- Active navigation state
- Header
- Breadcrumbs
- Page title
- Global notifications
- User/application menu
- Responsive desktop layout
- Loading states
- Empty states

## Test

Navigate through every route.

Verify:

- No broken route
- Sidebar collapse works
- Active page is highlighted
- Refreshing a route does not break navigation

## Acceptance

Every major future module has a functioning placeholder route.

---

# STEP 03 — Local Database Foundation

## Description

Create SQLite + Prisma and establish the database layer.

Create initial tables for:

```text
Workspace
Account
Page
Campaign
Content
ContentPreset
AutomationJob
ActivityLog
```

At this stage, only basic fields are required.

Example:

```text
Account
├── id
├── name
├── status
├── createdAt
└── updatedAt
```

## Test

- Database initializes automatically.
- Tables are created.
- Records can be inserted.
- Records can be read.
- Records can be updated.
- Records can be deleted.

## Acceptance

Restarting the application does not lose database records.

---

# STEP 04 — Workspace & Application Settings

## Description

Create the local workspace configuration.

Settings should include:

```text
Workspace Name
Default Download Folder
Default Content Folder
Browser Data Folder
Default Browser Concurrency
Theme
Notifications
Logging
```

Browser concurrency must allow:

```text
Minimum = 1
Maximum = 20
```

The setting should reject:

```text
0
21+
negative values
invalid text
```

## Test

Set concurrency to:

```text
1
2
10
20
```

Restart application and verify the selected value persists.

## Acceptance

The application always enforces the 1–20 concurrency limit.

---

# STEP 05 — Account Management UI

## Description

Build the account-management interface.

The user should be able to create an account record containing the information required for automation.

Features:

- Add account
- Edit account
- Delete account
- Search
- Filter
- Tags
- Categories
- Status
- Bulk selection
- Bulk delete
- Bulk category assignment

Account table:

```text
Select
Account
Category
Status
Pages
Last Used
Created
Actions
```

Important:

Credentials/secrets must not be exposed unnecessarily in the UI or logs.

## Test

Create 10 fake/test account records.

Verify:

- Search
- Filter
- Selection
- Bulk actions
- Edit
- Delete

## Acceptance

Account records can be managed reliably before any browser automation is introduced.

---

# STEP 06 — Browser Profile Manager

## Description

Create the browser-session management layer.

The system must support multiple independent browser profiles/sessions.

Example:

```text
Profile 01
Profile 02
Profile 03
...
Profile 20
```

A profile should maintain its own local browser state where appropriate.

Implement:

- Create profile
- Rename profile
- Delete profile
- Open profile
- Close profile
- Profile status
- Profile-to-account association
- Profile storage directory

## Test

Create 5 browser profiles.

Open:

```text
Profile 1
Profile 2
Profile 3
```

Verify they are separate browser sessions.

## Acceptance

The application can reliably create and destroy isolated browser sessions without corrupting other profiles.

---

# STEP 07 — Browser Concurrency Engine

## Description

Implement the core browser pool.

The browser pool is responsible for enforcing the user's selected concurrency.

Example:

```text
Concurrency = 2

Queue:
T1 T2 T3 T4 T5

Running:
T1 T2

Waiting:
T3 T4 T5
```

When T1 finishes:

```text
Running:
T2 T3
```

When T2 finishes:

```text
Running:
T3 T4
```

The engine must never exceed the configured concurrency.

## Test

Create 20 dummy browser tasks.

Run with:

```text
Concurrency = 2
```

Verify that no more than 2 browser workers are active.

Repeat:

```text
Concurrency = 1
Concurrency = 5
Concurrency = 10
Concurrency = 20
```

## Acceptance

Concurrency enforcement is deterministic and testable.

---

# STEP 08 — Generic Automation Task Engine

## Description

Create a generic task abstraction before implementing Facebook-specific workflows.

Task:

```text
id
type
status
priority
payload
progress
startedAt
completedAt
error
retryCount
```

Task lifecycle:

```text
PENDING
 ↓
RUNNING
 ↓
SUCCESS

or

RUNNING
 ↓
FAILED

or

RUNNING
 ↓
CANCELLED
```

## Test

Create 20 dummy tasks and process them through the browser pool.

Verify:

- Queue
- Start
- Progress
- Completion
- Failure
- Cancellation
- Retry

## Acceptance

The automation engine works independently of Facebook.

---

# STEP 09 — Automation Logging

## Description

Every browser task must produce structured logs.

Example:

```text
10:01:20 Worker 1 started
10:01:21 Browser launched
10:01:25 Navigation started
10:01:28 Action completed
10:01:35 Task successful
10:01:36 Browser closed
```

Logs should contain:

```text
Timestamp
Job ID
Task ID
Worker ID
Action
Status
Message
Error
```

Sensitive credentials must never be written to logs.

## Test

Run dummy tasks and inspect logs.

## Acceptance

Every task can be reconstructed from its logs without exposing secrets.

---

# STEP 10 — Account Browser Session Workflow

## Description

Connect account records to browser profiles and create the generic login/session workflow.

The automation should:

```text
Select Account
 ↓
Select/assign Browser Profile
 ↓
Launch Browser
 ↓
Navigate to login
 ↓
Perform supported login flow
 ↓
Detect successful login
 ↓
Store session state where appropriate
 ↓
Report result
```

The system must distinguish:

```text
LOGIN_SUCCESS
LOGIN_FAILED
AUTH_REQUIRED
TIMEOUT
UNKNOWN
```

If the platform requests additional verification, the system should report that condition rather than attempt to bypass it.

## Test

Use controlled test accounts/environments.

Verify each possible state.

## Acceptance

The automation engine can reliably determine whether a session reached the expected authenticated state.

---

# STEP 11 — Page Data Management

## Description

Create the page information system independent of page creation automation.

Page data includes:

```text
Page Name
Bio
Profile Image
Cover Image
Category
Account
Campaign
Status
```

The user can:

- Add page data
- Edit page data
- Import page data
- Delete page data
- Bulk edit
- Preview page identity

## Test

Create 20 page records and assign them to 20 account records.

## Acceptance

The application correctly maintains the account → page relationship.

---

# STEP 12 — Page Data Bulk Import

## Description

Provide a fast way to prepare many pages.

Support a structured import format such as CSV/Excel.

Example:

```text
Account
Page Name
Bio
Profile Image
Cover Image
Category
```

The application validates:

- Required fields
- Duplicate names
- Missing files
- Invalid file paths
- Duplicate account assignments

## Test

Import:

```text
20 pages
```

with intentional errors in several rows.

Verify invalid rows are reported without destroying valid rows.

## Acceptance

Bulk page preparation is reliable and user-friendly.

---

# STEP 13 — Page Creation Automation

## Description

Implement the first real browser automation workflow.

For each page task:

```text
Open assigned browser profile
 ↓
Login/check session
 ↓
Navigate to page creation
 ↓
Click create-page action
 ↓
Fill page name
 ↓
Fill bio
 ↓
Select category if required
 ↓
Upload profile image
 ↓
Upload cover image
 ↓
Submit
 ↓
Wait for result
 ↓
Detect success/failure
 ↓
Record result
```

The implementation should use robust page locators and state checks rather than blind timing wherever possible.

## Test

Start with:

```text
1 account
1 page
1 browser
```

Then:

```text
2 accounts
2 pages
2 browsers
```

Then:

```text
20 accounts
20 pages
2 browsers
```

## Acceptance

The complete 20-item job processes according to the configured concurrency and produces an accurate per-page result.

---

# STEP 14 — Page Creation Progress UI

## Description

Create the UI for monitoring page creation.

Display:

```text
Total: 20
Completed: 15
Running: 2
Failed: 1
Pending: 2
```

Also show individual workers:

```text
Browser 1 → Account 17 → Creating page
Browser 2 → Account 18 → Uploading image
```

## Test

Run a 20-page job.

Verify progress updates live.

## Acceptance

The user can understand exactly what the automation is doing.

---

# STEP 15 — Page Creation Retry System

## Description

Allow failed page tasks to be retried individually or in bulk.

Example:

```text
20 total
18 success
2 failed
```

Actions:

```text
Retry Failed
Retry Selected
Retry All
```

The retry system must preserve the original task data.

## Test

Force several dummy failures and retry them.

## Acceptance

Retrying does not duplicate already successful tasks.

---

# STEP 16 — Pages Management

## Description

Create the Pages module for pages already created or discovered.

Display:

```text
Page
Account
Category
Followers
Role
Status
Last Checked
Campaign
```

Actions:

```text
Open
Edit
Sync/Check
Assign Campaign
Add Tag
Remove
```

## Test

Create/import 20 pages and verify all table operations.

---

# STEP 17 — Content Folder Import

## Description

The user creates content outside the application and organizes it into folders.

The application imports these folders.

Example:

```text
Content/
├── Page-01/
│   ├── video1.mp4
│   ├── video2.mp4
│   └── video3.mp4
│
├── Page-02/
│   ├── video1.mp4
│   └── video2.mp4
```

The application should:

```text
Scan folder
 ↓
Find media
 ↓
Validate files
 ↓
Extract metadata
 ↓
Generate thumbnails
 ↓
Store content records
```

## Test

Import a folder containing:

- Valid videos
- Images
- Unsupported files
- Duplicate files

Verify correct classification.

## Acceptance

Content is imported without modifying the original user folder.

---

# STEP 18 — Content Library

## Description

Build the media library.

Features:

- Grid view
- List view
- Search
- Filter
- Category
- Campaign
- Page assignment
- Type
- Duration
- Date imported
- Preview
- Delete/archive

## Test

Import 100 media files.

Verify search/filter/preview.

## Acceptance

The user can quickly find and manage imported content.

---

# STEP 19 — Content Categories

## Description

Create categories for organizing imported content.

Examples:

```text
Animal Documentary
Funny Animals
Nature
Motivation
News
```

Allow:

- Create
- Rename
- Delete
- Assign
- Bulk assign

## Test

Assign imported content to multiple categories.

---

# STEP 20 — Content Presets

## Description

Create reusable posting configurations.

A preset may contain:

```text
Name
Type
Content Category
Folder
Media selection
Maximum media
Caption
Caption source
Selection mode
Duplicate policy
```

Example:

```text
Documentary Reel

Type:
REEL

Selection:
Sequential

Max Media:
1
```

## Test

Create presets for different content types.

---

# STEP 21 — Sequential & Random Content Selection

## Description

Implement content selection rules.

Sequential:

```text
1 → 2 → 3 → 4 → 5
```

Random:

```text
3 → 1 → 5 → 2 → 4
```

Also maintain usage history where required.

## Test

Run multiple selections and verify the configured behavior.

---

# STEP 22 — Caption Templates

## Description

Allow the user to provide captions manually.

Support:

```text
Fixed caption
Caption template
TXT file
Multiple captions
Sequential selection
Random selection
```

The user remains responsible for creating the actual content/captions.

## Test

Create 10 captions and verify both sequential and random modes.

---

# STEP 23 — Spin Text / Variable Text

## Description

Implement configurable text variations.

Example:

```text
{Amazing|Incredible|Unbelievable}
{wildlife|animals|nature}
```

The engine generates one valid combination when the post is executed.

## Test

Generate 100 combinations and verify the output always contains valid choices.

---

# STEP 24 — Dynamic Macros

## Description

Support macros such as:

```text
DATE
TIME
TIMESTAMP
RANDOM_NUMBER
RANDOM_TEXT
EMOJI
```

Macros are resolved when the content task executes.

## Test

Verify each macro independently and verify invalid macros produce a clear error.

---

# STEP 25 — Page ↔ Content Mapping

## Description

Create the mapping layer that determines what each page is allowed to publish.

Example:

```text
Page Group A
→ Animal Documentary preset

Page Group B
→ Image preset

Page Group C
→ Other Animal Content
```

Support:

- One page → many presets
- Many pages → one preset
- Campaign-based mapping
- Enable/disable mapping

## Test

Map 20 pages to different content strategies and verify correct selection.

---

# STEP 26 — Publishing Task Engine

## Description

Create a generic publishing task before implementing every individual post type.

Task:

```text
Page
Content
Caption
Preset
Scheduled Time
Status
```

Workflow:

```text
Load task
 ↓
Open browser
 ↓
Authenticate
 ↓
Navigate to publishing interface
 ↓
Upload media
 ↓
Enter text
 ↓
Submit
 ↓
Detect result
 ↓
Record publication
```

## Test

Start with one controlled publishing task.

---

# STEP 27 — Reel Publishing

## Description

Implement the Reel posting workflow using the browser automation engine.

The user selects:

```text
Pages
Preset
Content
Caption
```

The system creates tasks.

Example:

```text
20 pages
2 browsers
20 videos
```

The browser engine processes:

```text
2 at a time
```

until all tasks are completed.

## Test

Test:

```text
1 page
2 pages
5 pages
20 pages
```

with concurrency:

```text
1
2
5
20
```

## Acceptance

No more than the configured number of browser workers execute simultaneously.

---

# STEP 28 — Scheduled Publishing

## Description

Create the scheduler.

The user should be able to define:

```text
Date
Time
Timezone
Page
Content
Preset
```

The scheduler creates pending jobs.

At the scheduled time:

```text
Schedule
 ↓
Publishing Job
 ↓
Queue
 ↓
Browser Worker
```

## Test

Create a near-future test schedule and verify the job enters the queue at the expected time.

---

# STEP 29 — Posting Calendar

## Description

Build a visual calendar.

Views:

```text
Day
Week
Month
```

Show:

```text
Scheduled
Running
Published
Failed
```

Allow the user to click an item and view details.

---

# STEP 30 — Publishing History

## Description

Store every publishing attempt.

Fields:

```text
Page
Content
Date
Status
Browser Worker
Duration
Error
Result
```

## Test

Run successful and failed test tasks.

Verify the history remains after restarting the application.

---

# STEP 31 — Comments Automation

## Description

Create a comment workflow based on user-provided comment content/rules.

The system should:

```text
Select published content
 ↓
Select comment text
 ↓
Create comment task
 ↓
Run browser workflow
 ↓
Detect result
 ↓
Record result
```

Capabilities must remain within the supported platform behavior.

---

# STEP 32 — Story Workflow

## Description

Implement story posting if the required interface/functionality is available in the target environment.

Support:

```text
Media
Caption/text where available
Page
Schedule
Result
```

The workflow follows the same automation framework:

```text
Task
 ↓
Worker
 ↓
Browser
 ↓
Actions
 ↓
Result
```

---

# STEP 33 — Bulk Automation Control

## Description

Create a unified automation controller.

Actions:

```text
Start
Pause
Resume
Cancel
Retry Failed
Stop All
```

The system must safely stop new tasks while allowing active browser tasks to reach a controlled cleanup state where appropriate.

---

# STEP 34 — Worker Monitoring

## Description

Create a real-time worker monitor.

Example:

```text
Worker 01
Status: RUNNING
Account: Account 17
Page: Page 17
Task: Uploading media

Worker 02
Status: RUNNING
Account: Account 18
Page: Page 18
Task: Publishing

Worker 03
Status: IDLE
```

Maximum worker count must always equal or remain below the selected concurrency.

---

# STEP 35 — Global Activity Log

## Description

Record all major application actions.

Examples:

```text
Account added
Page data imported
Page creation started
Page creation completed
Content imported
Preset created
Publishing started
Publishing failed
Job retried
```

Provide:

- Search
- Filter
- Date range
- Entity filter
- Job filter

---

# STEP 36 — Error Center

## Description

Create a centralized error screen.

Group errors:

```text
Login
Navigation
Element Not Found
Upload
Timeout
Publishing
File
Browser
Application
```

Each error should show:

```text
Task
Account
Page
Time
Action
Error
Retry
```

---

# STEP 37 — Robust Browser Action Layer

## Description

Abstract browser actions so individual workflows do not contain duplicated low-level automation code.

Example:

```text
BrowserDriver
├── launch()
├── close()
├── navigate()
├── click()
├── fill()
├── upload()
├── waitFor()
├── exists()
├── screenshot()
└── getText()
```

Then workflow code becomes:

```text
navigate()
click()
fill()
upload()
waitFor()
```

instead of directly manipulating Playwright everywhere.

This makes future maintenance much easier if the target UI changes.

---

# STEP 38 — Selector & Workflow Configuration

## Description

Separate UI selectors from business logic where practical.

Example:

```text
Page Creation
├── createPageButton
├── nameInput
├── bioInput
├── profileUpload
├── coverUpload
└── submitButton
```

If the target UI changes, selectors can be updated without rewriting the whole job engine.

---

# STEP 39 — Screenshot / Debug Evidence

## Description

When a task fails, optionally capture:

```text
Screenshot
Current URL
Visible text
Task state
Worker ID
Timestamp
```

This allows debugging without manually reproducing every failure.

Sensitive information should be handled carefully.

---

# STEP 40 — Safe Cleanup

## Description

Every browser worker must have guaranteed cleanup.

Example:

```text
try:
    executeTask()
finally:
    cleanup()
    closeBrowser()
    releaseWorker()
```

The system must prevent orphaned browser processes.

## Test

Force errors during:

- Login
- Navigation
- Upload
- Submit
- Timeout

Verify the browser process is cleaned up.

---

# STEP 41 — Job Persistence

## Description

Jobs must survive application restarts.

If the application closes while:

```text
10 tasks are pending
2 are running
```

the application should reopen and classify jobs safely:

```text
PENDING
INTERRUPTED
COMPLETED
```

Interrupted jobs should require controlled recovery rather than blindly duplicating actions.

---

# STEP 42 — Duplicate-Action Protection

## Description

The system should prevent accidental duplicate operations.

Examples:

```text
Already-created page
Already-published content
Already-running task
```

Before executing a task:

```text
Check state
 ↓
If already completed:
    Skip
Else:
    Execute
```

This is especially important for bulk jobs.

---

# STEP 43 — Trash / Restore

## Description

Create a recoverable trash system.

Entities:

```text
Accounts
Pages
Content
Presets
Campaigns
```

Support:

```text
Move to Trash
Restore
Permanent Delete
Bulk Restore
```

---

# STEP 44 — Campaigns

## Description

Create Campaign as the primary organizational layer.

A campaign connects:

```text
Accounts
Pages
Content
Presets
Schedules
Automation
Analytics
```

Example:

```text
Wildlife Documentary

20 Pages
200 Videos
5 Presets
3 Posts/Day
```

---

# STEP 45 — Campaign Dashboard

## Description

Show:

```text
Pages
Content
Scheduled
Published
Failed
Running
```

And:

```text
Recent Jobs
Upcoming Posts
Recent Errors
```

This becomes the main operating screen for a campaign.

---

# STEP 46 — Multi-Page Bulk Operations

## Description

Every major operation should support:

```text
Single
Multiple
All
Filtered Selection
```

Examples:

```text
Create pages
Import content
Assign presets
Schedule content
Retry jobs
Delete
Restore
```

---

# STEP 47 — Search & Filtering System

## Description

Create a reusable filtering system.

Filters:

```text
Status
Category
Campaign
Account
Page
Date
Tag
Job type
```

The same filtering model should be reusable throughout the application.

---

# STEP 48 — Notifications

## Description

Provide user notifications for:

```text
Job completed
Job failed
Bulk operation finished
Browser error
Missing files
Authentication issue
```

Notification types:

```text
Success
Warning
Error
Info
```

---

# STEP 49 — Performance Optimization

## Description

After functional correctness is established, optimize:

- Browser startup
- File scanning
- Thumbnail generation
- Database queries
- UI rendering
- Job queue
- Memory usage
- CPU usage

Do not optimize before the core workflows are stable.

---

# STEP 50 — Packaging & Installer

## Description

Create a production desktop installer.

Requirements:

```text
Windows installer
Application icon
Versioning
Auto-update architecture
Data directory
Browser dependencies
Crash logging
```

The application must preserve user data during upgrades.

---

# STEP 51 — Full End-to-End Test

## Description

Run the complete workflow.

Example:

```text
20 accounts
20 page records
20 profile images
20 cover images
20 videos
Concurrency = 2
```

Workflow:

```text
Import accounts
 ↓
Import page data
 ↓
Create pages
 ↓
Import content
 ↓
Create preset
 ↓
Map content
 ↓
Create posting schedule
 ↓
Execute publishing
 ↓
Review results
```

Verify:

```text
20 page tasks
20 publishing tasks
Correct account mapping
Correct content mapping
Concurrency never > 2
Failures isolated
Results recorded
```

---

# STEP 52 — Stress Test

## Description

Test larger datasets.

Examples:

```text
50 accounts
100 pages
500 media files
20 browser concurrency
```

Measure:

```text
CPU
RAM
Disk
Browser processes
Database performance
Queue performance
UI responsiveness
```

---

# STEP 53 — Recovery Test

## Description

Intentionally interrupt the application during automation.

Examples:

```text
Close application
Kill browser
Network disconnect
Target page timeout
Invalid media
Unexpected UI
```

Verify:

```text
No corrupted database
No orphaned workers
Jobs recover safely
Results remain accurate
```

---

# STEP 54 — Final Security Review

## Description

Review:

```text
Credential storage
Local files
Browser profile data
Logs
Screenshots
IPC
File uploads
Path traversal
Command execution
Permissions
```

The Electron renderer must not receive unnecessary operating-system privileges.

---

# STEP 55 — Final Product QA

## Description

Run every feature from the beginning in order.

The final acceptance test should confirm:

```text
Application launches
 ↓
Accounts work
 ↓
Browser profiles work
 ↓
Concurrency works
 ↓
Jobs work
 ↓
Page data works
 ↓
Page automation works
 ↓
Content works
 ↓
Presets work
 ↓
Publishing works
 ↓
Scheduling works
 ↓
Monitoring works
 ↓
Recovery works
 ↓
Packaging works
```

---

# 9. Master Automation Architecture

```text
                    ┌───────────────────────┐
                    │      React UI         │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │    Electron IPC       │
                    └───────────┬───────────┘
                                │
               ┌────────────────┼────────────────┐
               ▼                ▼                ▼
        ┌────────────┐   ┌────────────┐   ┌────────────┐
        │ Database   │   │ Job Manager│   │ File Manager│
        └────────────┘   └─────┬──────┘   └────────────┘
                               │
                               ▼
                       ┌───────────────┐
                       │ Browser Pool  │
                       └───────┬───────┘
                               │
                    concurrency = 1..20
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         ┌────────┐       ┌────────┐       ┌────────┐
         │Worker 1│       │Worker 2│       │Worker N│
         └───┬────┘       └───┬────┘       └───┬────┘
             │                │                │
             ▼                ▼                ▼
          Browser          Browser          Browser
             │                │                │
             ▼                ▼                ▼
       Scripted Actions / Browser Workflows
```

---

# 10. Master Job Lifecycle

```text
CREATE JOB
    ↓
VALIDATE
    ↓
QUEUE
    ↓
WAIT FOR WORKER
    ↓
ALLOCATE BROWSER
    ↓
EXECUTE
    ↓
CHECK RESULT
    │
    ├── SUCCESS
    │      ↓
    │   SAVE RESULT
    │
    ├── FAILURE
    │      ↓
    │   SAVE ERROR
    │      ↓
    │   RETRY / FAIL
    │
    └── CANCEL
           ↓
        CLEANUP
```

---

# 11. Master Batch Algorithm

```text
function processBatch(tasks, concurrency):

    queue = createQueue(tasks)

    workers = createWorkerPool(
        maxWorkers = concurrency
    )

    while queue.hasPendingTasks():

        availableWorkers = workers.available()

        for worker in availableWorkers:

            if queue.empty():
                break

            task = queue.next()

            worker.run(task)

        waitForWorkerEvents()

        collectCompletedTasks()

        updateProgress()

    waitForAllWorkers()

    return jobSummary
```

---

# 12. Page Creation Algorithm

```text
function createPages(pageTasks, concurrency):

    return processBatch(
        tasks = pageTasks,
        concurrency = concurrency
    )
```

Worker:

```text
function pageCreationWorker(task):

    browser = browserPool.acquire()

    try:

        openProfile(browser, task.profile)

        loginIfRequired(browser)

        navigateToPageCreation(browser)

        fillName(task.pageName)

        fillBio(task.bio)

        uploadProfile(task.profileImage)

        uploadCover(task.coverImage)

        submit()

        result = detectResult()

        saveResult(task, result)

    catch error:

        saveFailure(task, error)

    finally:

        cleanup(browser)

        browserPool.release(browser)
```

---

# 13. Publishing Algorithm

```text
function publishPosts(postTasks, concurrency):

    return processBatch(
        tasks = postTasks,
        concurrency = concurrency
    )
```

Worker:

```text
function publishingWorker(task):

    browser = browserPool.acquire()

    try:

        openProfile(browser, task.profile)

        loginIfRequired(browser)

        navigateToPublishingInterface()

        upload(task.media)

        enterCaption(task.caption)

        submit()

        result = detectPublishResult()

        savePublication(task, result)

    catch error:

        saveFailure(task, error)

    finally:

        cleanup(browser)

        browserPool.release(browser)
```

---

# 14. Important Design Rule

Do not build separate queue systems for:

```text
Page Creation
Publishing
Comments
Stories
```

Instead, build one reusable automation engine.

Only the workflow changes.

```text
Automation Engine
       │
       ├── Page Creation Workflow
       ├── Publishing Workflow
       ├── Comment Workflow
       ├── Story Workflow
       └── Future Workflow
```

This will make the application dramatically easier to maintain.

---

# 15. Another Important Design Rule

Do not write automation code directly inside UI buttons.

Bad:

```text
onClick:
    launch browser
    click button
    upload file
```

Better:

```text
UI
 ↓
createJob()
 ↓
JobManager
 ↓
Workflow
 ↓
BrowserWorker
```

This makes:

- Testing easier
- Retry possible
- Cancellation possible
- Progress possible
- Logging possible
- Concurrency possible

---

# 16. Testing Strategy

Every step must have three levels where applicable.

## Level 1 — Unit Test

Test individual functions.

Example:

```text
parseSpinText()
validatePageData()
selectNextContent()
calculateBatch()
```

## Level 2 — Integration Test

Test components together.

Example:

```text
Job Manager
+
Browser Pool
+
Database
```

## Level 3 — Real Workflow Test

Test the actual browser workflow with a controlled account/task.

---

# 17. Definition of Done

A step is **not complete** just because the code works once.

A step is complete only when:

```text
✓ Feature implemented
✓ UI works
✓ Database state correct
✓ Errors handled
✓ Logs available
✓ Test completed
✓ Restart tested where relevant
✓ User confirms result
```

Only then:

```text
NEXT STEP
```

---

# 18. Build Order Summary

```text
01  Project Foundation
02  Application Shell
03  Database
04  Settings + Concurrency
05  Account Management
06  Browser Profiles
07  Browser Concurrency Engine
08  Generic Job Engine
09  Logging
10  Account Session Workflow
11  Page Data
12  Page Bulk Import
13  Page Creation Automation
14  Page Creation Progress
15  Page Retry
16  Pages Management
17  Content Import
18  Content Library
19  Categories
20  Presets
21  Content Selection
22  Captions
23  Spin Text
24  Macros
25  Page ↔ Content Mapping
26  Publishing Engine
27  Reel Publishing
28  Scheduling
29  Calendar
30  Publishing History
31  Comments
32  Stories
33  Bulk Automation Control
34  Worker Monitoring
35  Activity Log
36  Error Center
37  Browser Action Layer
38  Selector Configuration
39  Debug Evidence
40  Browser Cleanup
41  Job Persistence
42  Duplicate Protection
43  Trash
44  Campaigns
45  Campaign Dashboard
46  Bulk Operations
47  Search/Filters
48  Notifications
49  Performance
50  Installer
51  End-to-End Test
52  Stress Test
53  Recovery Test
54  Security Review
55  Final QA
```

---

# 19. How We Will Work Through This Plan

We should work strictly sequentially.

For example:

```text
STEP 01
Project Foundation
```

We implement it.

Then we test:

```text
✓ App opens
✓ UI renders
✓ Build succeeds
```

Only after it passes do we move to:

```text
STEP 02
Application Shell
```

At each step, the implementation discussion should contain:

```text
1. Goal
2. Existing architecture affected
3. Files/modules to create or modify
4. Implementation
5. How to run
6. How to test
7. Expected result
8. Common failures
9. Acceptance criteria
```

---

# 20. Final Development Philosophy

The final application should be built as a **reliable automation platform**, not as one giant script.

The fundamental relationship is:

```text
USER DATA
    ↓
CONFIGURATION
    ↓
JOB
    ↓
QUEUE
    ↓
BROWSER WORKER
    ↓
SCRIPTED ACTIONS
    ↓
RESULT DETECTION
    ↓
DATABASE
    ↓
UI / LOGS
```

And the fundamental scalability rule is:

```text
Concurrency = user-selected value from 1 to 20
```

The same engine must work whether the user chooses:

```text
1 browser
```

or:

```text
20 browsers
```

without changing the underlying workflow logic.

The first implementation target should therefore be **STEP 01 — Project Foundation**, and no later feature should be implemented until that step has been built and tested successfully.
