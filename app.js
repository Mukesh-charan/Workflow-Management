// Global in-memory representations sync'd from MongoDB cloud
let usersDB = [];
let clientMaster = [];
let engagementMaster = [];
let tasks = [];
let attendanceLogs = [];

let currentUserSession = null;
let activeTab = 'allAssigned';
let selectedOperatorFilter = 'ALL';
let allocationPieChartInstance = null;
let editingClientId = null;
let editingEngagementTitle = null;
let editingTaskId = null;
let editingTargetUsername = null;
let clientCurrentPage = 1;
let clientSearchQuery = '';
let userSearchQuery = '';
let activeClientPickerTarget = null;
let clientPickerSearchQuery = '';
let taskCurrentPage = 1;
let taskSearchQuery = '';
let tasksTotalCount = 0;
let tasksTotalPages = 1;
let attendanceCurrentPage = 1;
let attendanceTotalCount = 0;
let attendanceTotalPages = 1;
let auditLogsMaster = [];
let auditCurrentPage = 1;
let auditSearchQuery = '';
let auditTotalCount = 0;
let auditTotalPages = 1;
let clientsTotalCount = 0;
let clientsTotalPages = 1;
let _taskSearchDebounce = null;
let _clientSearchDebounce = null;


// Visual loading spinner togglers
function showSpinner(text) {
    document.getElementById('spinnerText').innerText = text || "Loading...";
    document.getElementById('spinnerBackdrop').classList.remove('hidden');
}
function hideSpinner() {
    document.getElementById('spinnerBackdrop').classList.add('hidden');
}


// Lightweight sync: only users + engagements + clients (small data, needed for dropdowns)
async function syncCoreState() {
    try {
        const [usersRes, engagementsRes] = await Promise.all([
            authFetch('/api/users').then(r => r.json()),
            authFetch('/api/engagements').then(r => r.json())
        ]);

        if (usersRes.success) usersDB = usersRes.users;
        if (engagementsRes.success) engagementMaster = engagementsRes.engagements;

        syncDropdownSelectElements();
        refreshUserSelectionDropdowns();
        populateOperatorFilterDropdown();
        populateKioskOperatorDropdown();
        populateAyDatalistOptions();
    } catch (e) {
        console.error("Failed to sync core state:", e);
        alert("Connection failed.");
    }
}

// Fetch tasks for the current tab with server-side filtering + pagination
async function fetchAndRenderTasks() {
    let statusFilter = '';
    let operatorFilter = '';

    if (activeTab === 'toBeAssigned') statusFilter = 'Unassigned';
    else if (activeTab === 'allAssigned') statusFilter = 'Assigned,Approved';
    else if (activeTab === 'pendingReview') statusFilter = 'Pending Review';
    else if (activeTab === 'closedArchive') statusFilter = 'Filed';
    else if (activeTab === 'myAllocations') {
        statusFilter = 'Assigned,Pending Review,Approved';
        operatorFilter = currentUserSession.username;
    }
    else if (activeTab === 'myClosed') {
        statusFilter = 'Filed';
        operatorFilter = currentUserSession.username;
    }

    if (selectedOperatorFilter !== 'ALL' && currentUserSession.role === 'partner') {
        operatorFilter = selectedOperatorFilter;
    }

    const params = new URLSearchParams({
        page: taskCurrentPage,
        limit: 25,
        status: statusFilter
    });
    if (operatorFilter) params.set('operator', operatorFilter);
    if (taskSearchQuery) params.set('search', taskSearchQuery);

    try {
        const res = await authFetch(`/api/tasks?${params}`).then(r => r.json());
        if (res.success) {
            tasks = res.tasks;
            tasksTotalCount = res.totalCount || 0;
            tasksTotalPages = res.totalPages || 1;
        }
    } catch (e) {
        console.error("Failed to fetch tasks:", e);
    }

    renderTaskTableBody();
}

// Fetch clients for Master Data tab with server-side search + pagination
async function fetchAndRenderClients() {
    const params = new URLSearchParams({
        page: clientCurrentPage,
        limit: 10
    });
    if (clientSearchQuery) params.set('search', clientSearchQuery);

    try {
        const res = await authFetch(`/api/clients?${params}`).then(r => r.json());
        if (res.success) {
            clientMaster = res.clients;
            clientsTotalCount = res.totalCount || 0;
            clientsTotalPages = res.totalPages || 1;
        }
    } catch (e) {
        console.error("Failed to fetch clients:", e);
    }
    renderClientTableBody();
}

// Fetch attendance with server-side date filtering + pagination
async function fetchAndRenderAttendance() {
    if (typeof renderPartnerAttendanceLogsViewport === 'function') {
        renderPartnerAttendanceLogsViewport();
    }
}

// Backward-compatible wrapper
async function syncDatabaseState() {
    await syncCoreState();
}

function populateAyDatalistOptions() {
    const ayList = document.getElementById('ayList');
    if (!ayList) return;
    ayList.innerHTML = "";
    const currentYear = new Date().getFullYear();
    const startYear = currentYear + 2;
    for (let y = startYear; y >= currentYear - 11; y--) {
        const nextShortYear = String(y + 1).slice(-2);
        const ayStr = `${y}-${nextShortYear}`;
        const opt = document.createElement('option');
        opt.value = ayStr;
        ayList.appendChild(opt);
    }
}

// Initial bootstrapping
window.addEventListener('DOMContentLoaded', async () => {
    // Restore session if active
    const session = sessionStorage.getItem('ca_secure_active_session');
    if (session) {
        showSpinner("Loading...");
        try {
            currentUserSession = JSON.parse(session);
            await syncDatabaseState();
            bootOfficeWorkspace();
        } catch (e) {
            console.error("Initial load error:", e);
            hideSpinner();
        }
    } else {
        // Show login form immediately
        hideSpinner();
    }
});

async function handleSecureLogin(e) {
    e.preventDefault();
    const uInput = document.getElementById('usernameInput').value.trim().toLowerCase();
    const pInput = document.getElementById('passwordInput').value;

    showSpinner("Logging in...");
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: uInput, password: pInput })
        }).then(r => r.json());

        if (res.success) {
            // Save token
            if (res.token) {
                sessionStorage.setItem('ca_secure_active_token', res.token);
            }
            // Check if biometric verification is required
            if (res.requireBiometric && res.faceDescriptor) {
                hideSpinner();
                temporaryAuthSession = { user: res.user, faceDescriptor: res.faceDescriptor };
                startBiometricScan('verify', res.user.username, res.faceDescriptor);
            } else {
                await completeSessionAccess(res.user);
            }
        } else {
            alert("Incorrect credentials.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function completeSessionAccess(user) {
    currentUserSession = user;
    sessionStorage.setItem('ca_secure_active_session', JSON.stringify(currentUserSession));
    await syncDatabaseState();
    bootOfficeWorkspace();
}

function handleSecureSignout() {
    sessionStorage.removeItem('ca_secure_active_session');
    sessionStorage.removeItem('ca_secure_active_token');
    currentUserSession = null;
    window.location.hash = ""; // Clear hash on signout
    document.getElementById('appContainer').classList.add('hidden');
    document.getElementById('authContainer').classList.remove('hidden');
}

function toggleAuthView(target) {
    if (target === 'forgot') {
        document.getElementById('loginCard').classList.add('hidden');
        document.getElementById('forgotCard').classList.remove('hidden');
    } else {
        document.getElementById('forgotCard').classList.add('hidden');
        document.getElementById('loginCard').classList.remove('hidden');
    }
}

function toggleClientModal(shouldShow, clientIdToEdit) {
    const overlay = document.getElementById('clientModalOverlay');
    const titleEl = overlay.querySelector('h3');
    const submitBtn = overlay.querySelector('button[type="submit"]');

    if (shouldShow) {
        // Populate GST Staff selection dropdown
        const gstStaffSelect = document.getElementById('modalClientGstStaff');
        if (gstStaffSelect) {
            gstStaffSelect.innerHTML = `<option value="">-- Choose Staff --</option>`;
            usersDB.forEach(u => {
                if (u.role !== 'partner') {
                    let opt = document.createElement('option');
                    opt.value = u.username;
                    opt.innerText = `${u.name} (${u.username})`;
                    gstStaffSelect.appendChild(opt);
                }
            });
        }

        if (clientIdToEdit) {
            editingClientId = clientIdToEdit;
            const client = clientMaster.find(c => c.id === clientIdToEdit);
            titleEl.innerText = "Edit Client";
            submitBtn.innerText = "Save";
            document.getElementById('modalClientId').value = client.id;
            document.getElementById('modalClientName').value = client.name;
            document.getElementById('modalClientPAN').value = client.pan || "";
            document.getElementById('modalClientContact').value = client.contact || "";
            document.getElementById('modalClientEmail').value = client.email || "";
            document.getElementById('modalClientPasswordITR').value = client.passwordITR || "";
            document.getElementById('modalClientTaxAuditCase').value = client.taxAuditCase || "";
            document.getElementById('modalClientDOB').value = formatDateForInput(client.dob);
            document.getElementById('modalClientAddress').value = client.address || "";
            document.getElementById('modalClientArea').value = client.area || "";
            document.getElementById('modalClientCity').value = client.city || "";
            document.getElementById('modalClientPinCode').value = client.pinCode || "";
            document.getElementById('modalClientAadhaar').value = client.aadhaar || "";
            document.getElementById('modalClientStatus').value = client.status || "Individual";
            document.getElementById('modalClientGstNumber').value = client.gstNumber || "";
            document.getElementById('modalClientGstUsername').value = client.gstUsername || "";
            document.getElementById('modalClientGstPassword').value = client.gstPassword || "";
            document.getElementById('modalClientGstStaff').value = client.gstStaff || "";
            document.getElementById('modalClientGstMobileNo').value = client.gstMobileNo || "";
            document.getElementById('modalClientGstContactPerson').value = client.gstContactPerson || "";
            document.getElementById('modalClientGstEmail').value = client.gstEmail || "";
        } else {
            editingClientId = null;
            titleEl.innerText = "Add Client";
            submitBtn.innerText = "Save";
            document.getElementById('modalClientId').value = "";
            document.getElementById('modalClientForm').reset();
            document.getElementById('modalClientStatus').value = "Individual";
            document.getElementById('modalClientGstNumber').value = "";
            document.getElementById('modalClientGstUsername').value = "";
            document.getElementById('modalClientGstPassword').value = "";
            document.getElementById('modalClientGstStaff').value = "";
            document.getElementById('modalClientGstMobileNo').value = "";
            document.getElementById('modalClientGstContactPerson').value = "";
            document.getElementById('modalClientGstEmail').value = "";
        }
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
        document.getElementById('modalClientForm').reset();
        editingClientId = null;
    }
}

function toggleEngagementModal(shouldShow, originalTitle) {
    const overlay = document.getElementById('engagementModalOverlay');
    const titleEl = overlay.querySelector('h3');
    const submitBtn = overlay.querySelector('button[type="submit"]');

    if (shouldShow) {
        if (originalTitle) {
            editingEngagementTitle = originalTitle;
            titleEl.innerText = "Edit Engagement";
            submitBtn.innerText = "Save";
            document.getElementById('modalEngagementTitle').value = originalTitle;
        } else {
            editingEngagementTitle = null;
            titleEl.innerText = "Add Engagement";
            submitBtn.innerText = "Save";
            document.getElementById('modalEngagementForm').reset();
        }
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
        document.getElementById('modalEngagementForm').reset();
        editingEngagementTitle = null;
    }
}

async function handleCreateEngagementFromModal(e) {
    e.preventDefault();
    if (currentUserSession.role !== 'partner') return;
    let title = document.getElementById('modalEngagementTitle').value.trim();

    const isEditing = editingEngagementTitle !== null;
    showSpinner("Saving...");
    try {
        const url = '/api/engagements';
        const method = isEditing ? 'PUT' : 'POST';
        const payload = isEditing
            ? { originalTitle: editingEngagementTitle, title }
            : { title };

        const res = await authFetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(r => r.json());

        if (res.success) {
            toggleEngagementModal(false);
            alert("Saved.");
            await syncDatabaseState();
            renderSystemDashboardEngine();
        } else {
            alert("Failed to save.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

function handleNatureOfWorkAyToggle(prefix) {
    const natureSelectId = prefix === 'assignWork' ? 'assignWorkNatureSelect' : 'natureOfWorkSelect';
    const ayGroup = document.getElementById(prefix === 'assignWork' ? 'assignWorkAyGroup' : 'staffAyGroup');
    const ayInput = document.getElementById(prefix === 'assignWork' ? 'assignWorkAssessmentYear' : 'staffAssessmentYear');
    if (!ayGroup || !ayInput) return;

    const natureVal = (document.getElementById(natureSelectId)?.value || '').toLowerCase().trim();
    const isGst = natureVal.includes('gst') || natureVal.includes('cmp');
    if (isGst) {
        ayGroup.classList.add('hidden');
        ayInput.value = "";
    } else {
        ayGroup.classList.remove('hidden');
    }
}

function toggleAssignWorkModal(shouldShow, taskIdToEdit) {
    const overlay = document.getElementById('assignWorkModalOverlay');
    const titleEl = overlay.querySelector('h3');
    const submitBtn = overlay.querySelector('button[type="submit"]');

    if (shouldShow) {
        const natureSelect = document.getElementById('assignWorkNatureSelect');
        natureSelect.innerHTML = "";
        engagementMaster.forEach(eng => {
            let opt = document.createElement('option');
            opt.value = eng;
            opt.innerText = eng;
            natureSelect.appendChild(opt);
        });

        const operatorSelect = document.getElementById('assignWorkOperatorSelect');
        operatorSelect.innerHTML = `<option value="">-- Leave Unassigned (Pool) --</option>`;
        usersDB.forEach(u => {
            if (u.role !== 'partner') {
                let opt = document.createElement('option');
                opt.value = u.username;
                opt.innerText = `${u.name} (${u.username})`;
                operatorSelect.appendChild(opt);
            }
        });

        if (currentUserSession.role !== 'partner') {
            operatorSelect.disabled = true;
        } else {
            operatorSelect.disabled = false;
        }

        if (taskIdToEdit) {
            editingTaskId = taskIdToEdit;
            const task = tasks.find(t => t.id === taskIdToEdit);
            titleEl.innerText = "Edit Task";
            submitBtn.innerText = "Save";

            document.getElementById('assignWorkClientSelect').value = JSON.stringify({ id: parseInt(task.clientCode), name: task.clientName });
            document.getElementById('assignWorkClientSelect_display').value = `[#${task.clientCode}] ${task.clientName}`;
            natureSelect.value = task.natureOfWork;
            operatorSelect.value = task.workTakenBy || "";
            document.getElementById('assignWorkDueDate').value = task.dueDate;
            document.getElementById('assignWorkAssessmentYear').value = task.assessmentYear || "";
        } else {
            editingTaskId = null;
            titleEl.innerText = "Assign Work";
            submitBtn.innerText = "Assign";
            document.getElementById('assignWorkForm').reset();
            document.getElementById('assignWorkClientSelect').value = "";
            document.getElementById('assignWorkClientSelect_display').value = "";
            document.getElementById('assignWorkAssessmentYear').value = "";
        }

        handleNatureOfWorkAyToggle('assignWork');
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
        document.getElementById('assignWorkForm').reset();
        document.getElementById('assignWorkClientSelect').value = "";
        document.getElementById('assignWorkClientSelect_display').value = "";
        document.getElementById('assignWorkAssessmentYear').value = "";
        editingTaskId = null;
    }
}

function toggleStaffTaskModal(shouldShow) {
    const overlay = document.getElementById('staffTaskModalOverlay');
    if (!overlay) return;
    if (shouldShow) {
        document.getElementById('taskForm').reset();
        document.getElementById('clientSelectField').value = "";
        document.getElementById('clientSelectField_display').value = "";
        document.getElementById('dateReceived').value = new Date().toLocaleDateString('sv-SE');
        document.getElementById('staffAssessmentYear').value = "";
        handleNatureOfWorkAyToggle('staff');
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

function handleAddTaskButtonClick() {
    if (currentUserSession.role === 'partner') {
        toggleAssignWorkModal(true);
    } else {
        toggleStaffTaskModal(true);
    }
}

async function handleAssignWorkSubmission(e) {
    e.preventDefault();
    if (currentUserSession.role !== 'partner' && editingTaskId === null) return;

    const clientParsed = JSON.parse(document.getElementById('assignWorkClientSelect').value);
    const natureOfWork = document.getElementById('assignWorkNatureSelect').value;
    const operator = document.getElementById('assignWorkOperatorSelect').value;
    const dueDate = document.getElementById('assignWorkDueDate').value;
    const assessmentYear = document.getElementById('assignWorkAssessmentYear').value.trim();

    const isEditing = editingTaskId !== null;
    showSpinner("Saving...");
    try {
        let res;
        if (isEditing) {
            res = await authFetch('/api/tasks', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: editingTaskId,
                    clientCode: String(clientParsed.id),
                    clientName: clientParsed.name,
                    natureOfWork: natureOfWork,
                    assessmentYear: assessmentYear,
                    operator: operator,
                    dueDate: dueDate
                })
            }).then(r => r.json());
        } else {
            const today = new Date().toISOString().split('T')[0];
            res = await authFetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientCode: String(clientParsed.id),
                    clientName: clientParsed.name,
                    natureOfWork: natureOfWork,
                    assessmentYear: assessmentYear,
                    dateReceived: today,
                    dueDate: dueDate,
                    operator: operator
                })
            }).then(r => r.json());
        }

        if (res.success) {
            toggleAssignWorkModal(false);
            alert("Saved.");
            await fetchAndRenderTasks();
        } else {
            alert(res.message || "Failed to save.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function deleteTaskRecord(taskId) {
    if (currentUserSession.role !== 'partner') return;
    if (!confirm("Delete task?")) return;

    showSpinner("Deleting...");
    try {
        const res = await authFetch(`/api/tasks?id=${taskId}`, {
            method: 'DELETE'
        }).then(r => r.json());

        if (res.success) {
            alert("Deleted.");
            await fetchAndRenderTasks();
        } else {
            alert("Failed to delete.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

function toggleUserEditModal(shouldShow, usernameToEdit) {
    const overlay = document.getElementById('userModalOverlay');
    if (shouldShow) {
        if (usernameToEdit) {
            editingTargetUsername = usernameToEdit;
            const u = usersDB.find(usr => usr.username === usernameToEdit);
            document.getElementById('editUserFullName').value = u.name;
            document.getElementById('editUserUsername').value = u.username;
            document.getElementById('editUserPassword').value = "";
            document.getElementById('editUserRole').value = u.role;
        }
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
        document.getElementById('editUserForm').reset();
        editingTargetUsername = null;
    }
}

async function handleEditUserSubmission(e) {
    e.preventDefault();
    if (currentUserSession.role !== 'partner') return;

    const name = document.getElementById('editUserFullName').value.trim();
    const username = document.getElementById('editUserUsername').value.trim().toLowerCase();
    const password = document.getElementById('editUserPassword').value;
    const role = document.getElementById('editUserRole').value;

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/users', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                originalUsername: editingTargetUsername,
                username,
                password: password || undefined,
                name,
                role
            })
        }).then(r => r.json());

        if (res.success) {
            toggleUserEditModal(false);
            alert("Saved.");
            if (editingTargetUsername === currentUserSession.username) {
                currentUserSession.username = username;
                currentUserSession.name = name;
                currentUserSession.role = role;
                sessionStorage.setItem('ca_secure_active_session', JSON.stringify(currentUserSession));
                bootOfficeWorkspace();
            }
            await syncDatabaseState();
            renderPartnerAdminCenterViewports();
        } else {
            alert("Failed to save.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function deleteUserAccount(username) {
    if (currentUserSession.role !== 'partner') return;
    if (username === currentUserSession.username) {
        alert("Cannot delete your own account.");
        return;
    }

    if (!confirm(`Delete user "${username}"?`)) return;

    showSpinner("Deleting...");
    try {
        const res = await authFetch(`/api/users?username=${username}`, {
            method: 'DELETE'
        }).then(r => r.json());

        if (res.success) {
            alert("Deleted.");
            await syncDatabaseState();
            renderPartnerAdminCenterViewports();
        } else {
            alert("Failed to delete.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

function editClientProfile(clientId) {
    toggleClientModal(true, clientId);
}

function editEngagementType(title) {
    toggleEngagementModal(true, title);
}

function editUserAccount(username) {
    toggleUserEditModal(true, username);
}

function editTaskProfile(taskId) {
    toggleAssignWorkModal(true, taskId);
}

function bootOfficeWorkspace() {
    document.getElementById('authContainer').classList.add('hidden');
    document.getElementById('appContainer').classList.remove('hidden');
    document.getElementById('displayUser').innerText = currentUserSession.name;
    document.getElementById('displayRole').innerText = currentUserSession.role;

    const tabsMenu = document.getElementById('tabsMenu');
    const leftForms = document.getElementById('leftFormsContainer');
    const mainGrid = document.getElementById('mainGrid');

    const currentHash = window.location.hash.substring(1);
    const partnerTabs = ['toBeAssigned', 'allAssigned', 'pendingReview', 'closedArchive', 'masterData', 'attendanceLogs', 'analyticsSuite', 'adminCenter'];
    const staffTabs = ['myAllocations', 'myClosed', 'masterData'];

    if (currentUserSession.role === 'partner') {
        leftForms.classList.add('hidden');
        mainGrid.classList.remove('split');
        tabsMenu.innerHTML = `
            <div class="menu-header">
                <span>Navigation Menu</span>
                <button class="menu-close-btn" onclick="toggleSideMenu(false)">&times;</button>
            </div>
            <button class="tab-btn" id="tab_toBeAssigned" onclick="switchActiveTab('toBeAssigned')">Unassigned Tasks</button>
            <button class="tab-btn" id="tab_allAssigned" onclick="switchActiveTab('allAssigned')">Active Tasks</button>
            <button class="tab-btn" id="tab_pendingReview" onclick="switchActiveTab('pendingReview')">Pending for Review</button>
            <button class="tab-btn" id="tab_closedArchive" onclick="switchActiveTab('closedArchive')">Closed Tasks</button>
            <button class="tab-btn" id="tab_masterData" onclick="switchActiveTab('masterData')">Master Data</button>
            <button class="tab-btn" id="tab_attendanceLogs" onclick="switchActiveTab('attendanceLogs')">Attendance</button>
            <button class="tab-btn" id="tab_analyticsSuite" onclick="switchActiveTab('analyticsSuite')">Analytics</button>
            <button class="tab-btn" id="tab_adminCenter" onclick="switchActiveTab('adminCenter')">Admin Control Panel</button>
        `;
        if (partnerTabs.includes(currentHash)) {
            activeTab = currentHash;
        } else {
            activeTab = 'allAssigned';
        }
        refreshUserSelectionDropdowns();
        populateOperatorFilterDropdown();
    } else {
        leftForms.classList.add('hidden');
        mainGrid.classList.remove('split');
        tabsMenu.innerHTML = `
            <div class="menu-header">
                <span>Navigation Menu</span>
                <button class="menu-close-btn" onclick="toggleSideMenu(false)">&times;</button>
            </div>
            <button class="tab-btn" id="tab_myAllocations" onclick="switchActiveTab('myAllocations')">Open Tasks</button>
            <button class="tab-btn" id="tab_myClosed" onclick="switchActiveTab('myClosed')">Closed Tasks</button>
            <button class="tab-btn" id="tab_masterData" onclick="switchActiveTab('masterData')">Master Data</button>
        `;
        if (staffTabs.includes(currentHash)) {
            activeTab = currentHash;
        } else {
            activeTab = 'myAllocations';
        }
    }

    // Set URL hash to match current active tab
    window.location.hash = activeTab;

    clientCurrentPage = 1;
    clientSearchQuery = '';
    userSearchQuery = '';
    const clientInput = document.getElementById('clientSearchInput');
    if (clientInput) clientInput.value = '';
    const userInput = document.getElementById('userSearchInput');
    if (userInput) userInput.value = '';

    const odDateInput = document.getElementById('odDateInput');
    if (odDateInput) {
        odDateInput.value = new Date().toLocaleDateString('sv-SE');
    }

    const attDateInput = document.getElementById('attendanceFilterDate');
    if (attDateInput) {
        attDateInput.value = new Date().toLocaleDateString('sv-SE');
    }
    const attMonthInput = document.getElementById('attendanceFilterMonth');
    if (attMonthInput) {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        attMonthInput.value = `${yyyy}-${mm}`;
    }
    const auditInput = document.getElementById('auditSearchInput');
    if (auditInput) {
        auditInput.value = '';
    }
    attendanceCurrentPage = 1;
    taskCurrentPage = 1;
    auditCurrentPage = 1;
    auditSearchQuery = '';

    syncDropdownSelectElements();
    renderSystemDashboardEngine();
    hideSpinner();
}

function toggleSideMenu(isOpen) {
    const tabsContainer = document.getElementById('tabsMenu');
    const backdrop = document.getElementById('menuBackdrop');
    if (!tabsContainer || !backdrop) return;
    if (isOpen) {
        tabsContainer.classList.add('open');
        backdrop.classList.remove('hidden');
    } else {
        tabsContainer.classList.remove('open');
        backdrop.classList.add('hidden');
    }
}

function switchActiveTab(targetTabId) {
    activeTab = targetTabId;
    window.location.hash = targetTabId; // Sync hash on tab switch
    selectedOperatorFilter = 'ALL';
    const selectEl = document.getElementById('operatorFilterSelect');
    if (selectEl) selectEl.value = 'ALL';
    taskCurrentPage = 1;
    taskSearchQuery = '';
    const taskInput = document.getElementById('taskSearchInput');
    if (taskInput) taskInput.value = '';
    renderSystemDashboardEngine();
    toggleSideMenu(false);
}

function handleClientSearch(val) {
    clientSearchQuery = val.trim().toLowerCase();
    clientCurrentPage = 1;
    clearTimeout(_clientSearchDebounce);
    _clientSearchDebounce = setTimeout(() => {
        fetchAndRenderClients();
    }, 300);
}

function handleTaskSearch(val) {
    taskSearchQuery = val;
    taskCurrentPage = 1;
    clearTimeout(_taskSearchDebounce);
    _taskSearchDebounce = setTimeout(() => {
        fetchAndRenderTasks();
    }, 300);
}

function handleUserSearch(val) {
    userSearchQuery = val.trim().toLowerCase();
    renderPartnerAdminCenterViewports();
}

function changeClientPage(page) {
    clientCurrentPage = page;
    fetchAndRenderClients();
}

function syncDropdownSelectElements() {
    const natureSelect = document.getElementById('natureOfWorkSelect');
    if (natureSelect) {
        natureSelect.innerHTML = "";
        engagementMaster.forEach(eng => {
            let opt = document.createElement('option');
            opt.value = eng;
            opt.innerText = eng;
            natureSelect.appendChild(opt);
        });
    }
}

async function handleCreateClientMaster(e) {
    e.preventDefault();
    let manualIdInput = document.getElementById('modalClientId').value.trim();
    let clientNameVal = document.getElementById('modalClientName').value.trim();
    let panVal = document.getElementById('modalClientPAN').value.trim().toUpperCase();
    let contactVal = document.getElementById('modalClientContact').value.trim();
    let emailVal = document.getElementById('modalClientEmail').value.trim();
    let passwordITRVal = document.getElementById('modalClientPasswordITR').value.trim();
    let taxAuditCaseVal = document.getElementById('modalClientTaxAuditCase').value;
    let dobVal = document.getElementById('modalClientDOB').value.trim();
    let addressVal = document.getElementById('modalClientAddress').value.trim();
    let areaVal = document.getElementById('modalClientArea').value.trim();
    let cityVal = document.getElementById('modalClientCity').value.trim();
    let pinCodeVal = document.getElementById('modalClientPinCode').value.trim();
    let aadhaarVal = document.getElementById('modalClientAadhaar').value.trim();
    let statusVal = document.getElementById('modalClientStatus').value;
    let gstNumberVal = document.getElementById('modalClientGstNumber').value.trim();
    let gstUsernameVal = document.getElementById('modalClientGstUsername').value.trim();
    let gstPasswordVal = document.getElementById('modalClientGstPassword').value.trim();
    let gstStaffVal = document.getElementById('modalClientGstStaff').value;
    let gstMobileNoVal = document.getElementById('modalClientGstMobileNo').value.trim();
    let gstContactPersonVal = document.getElementById('modalClientGstContactPerson').value.trim();
    let gstEmailVal = document.getElementById('modalClientGstEmail').value.trim();

    const isEditing = (editingClientId !== null);
    showSpinner("Saving...");
    try {
        const method = isEditing ? 'PUT' : 'POST';
        const payload = {
            id: isEditing ? editingClientId : (manualIdInput ? parseInt(manualIdInput) : undefined),
            name: clientNameVal,
            pan: panVal,
            contact: contactVal,
            email: emailVal,
            passwordITR: passwordITRVal,
            taxAuditCase: taxAuditCaseVal,
            dob: dobVal,
            address: addressVal,
            area: areaVal,
            city: cityVal,
            pinCode: pinCodeVal,
            aadhaar: aadhaarVal,
            status: statusVal,
            gstNumber: gstNumberVal,
            gstUsername: gstUsernameVal,
            gstPassword: gstPasswordVal,
            gstStaff: gstStaffVal,
            gstMobileNo: gstMobileNoVal,
            gstContactPerson: gstContactPersonVal,
            gstEmail: gstEmailVal
        };

        const res = await authFetch('/api/clients', {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(r => r.json());

        if (res.success) {
            toggleClientModal(false);
            alert("Saved.");
            await fetchAndRenderClients();
        } else {
            alert(res.message || "Failed to save.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function handleCreateEngagement(e) {
    e.preventDefault();
    if (currentUserSession.role !== 'partner') return;
    let title = document.getElementById('engagementTitle').value.trim();

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/engagements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        }).then(r => r.json());

        if (res.success) {
            document.getElementById('newEngagementForm').reset();
            alert("Saved.");
            await syncCoreState();
            renderPartnerMasterDataViewports();
        } else {
            alert("Failed to save.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function administrativeExecuteDeleteClient(clientId) {
    const allowedRoles = ['partner', 'staff', 'article'];
    if (!allowedRoles.includes(currentUserSession.role)) return;
    let profile = clientMaster.find(c => c.id === clientId);
    if (!profile) return;

    if (confirm(`Delete client "${profile.name}" and all their tasks?`)) {
        showSpinner("Deleting...");
        try {
            const res = await authFetch(`/api/clients?id=${clientId}`, {
                method: 'DELETE'
            }).then(r => r.json());

            if (res.success) {
                alert("Deleted.");
                await fetchAndRenderClients();
            } else {
                alert("Failed to delete.");
            }
        } catch (err) {
            alert("Network error.");
        } finally {
            hideSpinner();
        }
    }
}

async function administrativeExecuteDeleteEngagement(engTitle) {
    if (currentUserSession.role !== 'partner') return;
    if (confirm(`Delete engagement type "${engTitle}"?`)) {
        showSpinner("Deleting...");
        try {
            const res = await authFetch(`/api/engagements?title=${encodeURIComponent(engTitle)}`, {
                method: 'DELETE'
            }).then(r => r.json());

            if (res.success) {
                alert("Deleted.");
                await syncCoreState();
                renderPartnerMasterDataViewports();
            } else {
                alert("Failed to delete.");
            }
        } catch (err) {
            alert("Network error.");
        } finally {
            hideSpinner();
        }
    }
}

async function exportDataEngine(targetScope) {
    showSpinner("Exporting CSV...");
    try {
        let rows = [];
        let fileName = `CA_Workflow_Report_${targetScope}.csv`;
        if (targetScope === 'CLIENTS') {
            const res = await authFetch('/api/clients').then(r => r.json());
            const clientList = res.success ? res.clients : [];
            rows.push(["Client ID", "Client Name", "PAN Number", "Contact Number", "Email Address"]);
            clientList.forEach(c => rows.push([c.id, c.name, c.pan || '-', c.contact || '-', c.email || '-']));
        } else {
            let statusParam = '';
            if (targetScope === 'toBeAssigned') statusParam = 'Unassigned';
            else if (targetScope === 'allAssigned') statusParam = 'Assigned,Approved';
            else if (targetScope === 'pendingReview') statusParam = 'Pending Review';
            else if (targetScope === 'closedArchive') statusParam = 'Filed';

            const params = new URLSearchParams();
            if (statusParam) params.set('status', statusParam);

            const res = await authFetch(`/api/tasks?${params}`).then(r => r.json());
            const exportTasks = res.success ? res.tasks : [];

            rows.push(["Sl No", "Task ID", "Client Code", "Client Name", "Engagement", "Assessment Year", "Inward Date", "Due Date", "Operator ID", "Commenced Date", "Status", "Reworks", "Pending Reason"]);
            exportTasks.forEach((t, idx) => rows.push([(idx + 1), t.id, t.clientCode, t.clientName, t.natureOfWork, t.assessmentYear || '-', t.dateReceived, t.dueDate, t.workTakenBy || 'Pool', t.workTakenOn || '-', t.currentStatus, t.sendBackCount, t.reasonForPending || '']));
        }
        let csvContent = "data:text/csv;charset=utf-8,\u200B" + rows.map(r => r.map(f => `"${String(f).replace(/"/g, '""')}"`).join(",")).join("\n");
        let encodedUri = encodeURI(csvContent);
        let link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", fileName);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (e) {
        alert("Export failed: " + (e.message || "Network error"));
    } finally {
        hideSpinner();
    }
}

async function exportCurrentLedgerData() {
    showSpinner("Exporting CSV...");
    try {
        let statusFilter = '';
        let operatorFilter = '';

        if (activeTab === 'toBeAssigned') statusFilter = 'Unassigned';
        else if (activeTab === 'allAssigned') statusFilter = 'Assigned,Approved';
        else if (activeTab === 'pendingReview') statusFilter = 'Pending Review';
        else if (activeTab === 'closedArchive') statusFilter = 'Filed';
        else if (activeTab === 'myAllocations') {
            statusFilter = 'Assigned,Pending Review,Approved';
            operatorFilter = currentUserSession.username;
        }
        else if (activeTab === 'myClosed') {
            statusFilter = 'Filed';
            operatorFilter = currentUserSession.username;
        }

        if (selectedOperatorFilter !== 'ALL' && currentUserSession.role === 'partner') {
            operatorFilter = selectedOperatorFilter;
        }

        const params = new URLSearchParams();
        if (statusFilter) params.set('status', statusFilter);
        if (operatorFilter) params.set('operator', operatorFilter);
        if (taskSearchQuery) params.set('search', taskSearchQuery);

        const res = await authFetch(`/api/tasks?${params}`).then(r => r.json());
        const exportTasks = res.success ? res.tasks : [];

        let rows = [];
        rows.push(["Sl No", "Task ID", "Client Code", "Client Name", "Engagement", "Assessment Year", "Inward Date", "Due Date", "Operator ID", "Commenced Date", "Status", "Reworks", "Pending Reason"]);

        exportTasks.forEach((t, idx) => rows.push([(idx + 1), t.id, t.clientCode, t.clientName, t.natureOfWork, t.assessmentYear || '-', t.dateReceived, t.dueDate, t.workTakenBy || 'Pool', t.workTakenOn || '-', t.currentStatus, t.sendBackCount, t.reasonForPending || '']));

        let fileName = `CA_Workflow_${activeTab}_Report.csv`;
        let csvContent = "data:text/csv;charset=utf-8,\u200B" + rows.map(r => r.map(f => `"${String(f).replace(/"/g, '""')}"`).join(",")).join("\n");
        let encodedUri = encodeURI(csvContent);
        let link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", fileName);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (e) {
        alert("Export failed: " + (e.message || "Network error"));
    } finally {
        hideSpinner();
    }
}

function toggleSelfPasswordModal(shouldShow) {
    const overlay = document.getElementById('selfPasswordModalOverlay');
    if (shouldShow) {
        overlay.classList.remove('hidden');
        document.getElementById('modalSelfNewPassword').value = "";
    } else {
        overlay.classList.add('hidden');
        document.getElementById('selfPasswordForm').reset();
    }
}

async function handleSelfPasswordChangeFromModal(e) {
    e.preventDefault();
    const newPass = document.getElementById('modalSelfNewPassword').value;

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'changePassword',
                username: currentUserSession.username,
                newPassword: newPass
            })
        }).then(r => r.json());

        if (res.success) {
            toggleSelfPasswordModal(false);
            alert("Password updated successfully.");
        } else {
            alert("Failed to update password.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function handlePartnerOverrideUserPassword(e) {
    e.preventDefault();
    const userHandle = document.getElementById('resetTargetUserSelect').value;
    const forcedPass = document.getElementById('resetNewPassword').value;

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'resetPassword',
                targetUser: userHandle,
                newPassword: forcedPass
            })
        }).then(r => r.json());

        if (res.success) {
            document.getElementById('resetUserForm').reset();
            alert("Saved.");
        } else {
            alert("Failed to save.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

function refreshUserSelectionDropdowns() {
    const selectEl = document.getElementById('resetTargetUserSelect');
    if (selectEl) {
        selectEl.innerHTML = "";
        usersDB.forEach(u => {
            let opt = document.createElement('option');
            opt.value = u.username;
            opt.innerText = `${u.name} (${u.username})`;
            selectEl.appendChild(opt);
        });
    }

    const odSelectEl = document.getElementById('odTargetUserSelect');
    if (odSelectEl) {
        odSelectEl.innerHTML = "";
        usersDB.forEach(u => {
            if (u.role !== 'partner') {
                let opt = document.createElement('option');
                opt.value = JSON.stringify({ username: u.username, name: u.name, role: u.role });
                opt.innerText = `${u.name} (${u.username}) [${u.role.toUpperCase()}]`;
                odSelectEl.appendChild(opt);
            }
        });
    }
}

async function handleManualODSubmission(e) {
    e.preventDefault();
    if (currentUserSession.role !== 'partner') return;

    const odTargetSelected = JSON.parse(document.getElementById('odTargetUserSelect').value);
    const odDate = document.getElementById('odDateInput').value;

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/attendance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'markOD',
                username: odTargetSelected.username,
                name: odTargetSelected.name,
                role: odTargetSelected.role,
                date: odDate
            })
        }).then(r => r.json());

        if (res.success) {
            alert("On-Duty (OD) marked successfully.");
            if (typeof renderPartnerAttendanceLogsViewport === 'function') {
                renderPartnerAttendanceLogsViewport();
            }
        } else {
            alert(res.message || "Failed to mark On-Duty.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

function populateOperatorFilterDropdown() {
    const selectEl = document.getElementById('operatorFilterSelect');
    if (!selectEl) return;
    selectEl.innerHTML = `<option value="ALL">All Operators</option>`;
    usersDB.forEach(u => {
        if (u.role !== 'partner') {
            let opt = document.createElement('option');
            opt.value = u.username;
            opt.innerText = u.name;
            selectEl.appendChild(opt);
        }
    });
}

function handleOperatorFilterChange() {
    selectedOperatorFilter = document.getElementById('operatorFilterSelect').value;
    taskCurrentPage = 1;
    renderSystemDashboardEngine();
}

async function handleOfficeUserCreation(e) {
    e.preventDefault();
    const fullName = document.getElementById('newFullName').value.trim();
    const username = document.getElementById('newUsername').value.trim().toLowerCase();
    const password = document.getElementById('newPassword').value;
    const role = document.getElementById('newRole').value;

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'create',
                username,
                password,
                name: fullName,
                role
            })
        }).then(r => r.json());

        if (res.success) {
            document.getElementById('newUserForm').reset();
            alert("Saved.");
            await syncCoreState();
            renderPartnerAdminCenterViewports();
        } else {
            alert("Failed to save.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function handleNewWorkSubmission(e) {
    e.preventDefault();
    const clientParsed = JSON.parse(document.getElementById('clientSelectField').value);
    const assessmentYear = (document.getElementById('staffAssessmentYear')?.value || '').trim();

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientCode: String(clientParsed.id),
                clientName: clientParsed.name,
                natureOfWork: document.getElementById('natureOfWorkSelect').value,
                assessmentYear: assessmentYear,
                dateReceived: document.getElementById('dateReceived').value,
                dueDate: document.getElementById('dueDate').value,
                operator: currentUserSession.username
            })
        }).then(r => r.json());

        if (res.success) {
            document.getElementById('taskForm').reset();
            document.getElementById('clientSelectField').value = "";
            document.getElementById('clientSelectField_display').value = "";
            document.getElementById('staffAssessmentYear').value = "";
            toggleStaffTaskModal(false);
            alert("Saved.");
            await fetchAndRenderTasks();
        } else {
            alert(res.message || "Failed to save.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function handlePartnerInlineDateChange(taskId, dateVal) {
    const index = tasks.findIndex(t => t.id === taskId);
    if (index !== -1 && tasks[index].currentStatus !== 'Completed') {
        showSpinner("Saving...");
        try {
            const res = await authFetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: taskId,
                    action: 'changeDueDate',
                    dueDate: dateVal
                })
            }).then(r => r.json());

            if (res.success) {
                await fetchAndRenderTasks();
            } else {
                alert("Failed to update.");
            }
        } catch (err) {
            alert("Network error.");
        } finally {
            hideSpinner();
        }
    }
}

let reassigningTaskId = null;

function toggleReassignModal(shouldShow, taskId) {
    const overlay = document.getElementById('reassignModalOverlay');
    const selectEl = document.getElementById('reassignOperatorSelect');
    const titleEl = document.getElementById('reassignModalTitle');
    const submitBtn = overlay ? overlay.querySelector('button[type="submit"]') : null;

    if (shouldShow) {
        reassigningTaskId = taskId;
        const task = tasks.find(t => t.id === taskId);
        const isReassign = task && task.workTakenBy;

        if (titleEl) titleEl.innerText = isReassign ? "Reassign Task" : "Assign Task";
        if (submitBtn) {
            submitBtn.innerText = isReassign ? "Reassign" : "Assign";
            submitBtn.style.backgroundColor = isReassign ? "var(--warning-color)" : "var(--accent-color)";
        }

        if (selectEl) {
            selectEl.innerHTML = "";
            usersDB.forEach(u => {
                if (u.role !== 'partner') {
                    let opt = document.createElement('option');
                    opt.value = u.username;
                    opt.innerText = `${u.name} (${u.username})`;
                    selectEl.appendChild(opt);
                }
            });
            if (task && task.workTakenBy) {
                selectEl.value = task.workTakenBy;
            }
        }
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
        reassigningTaskId = null;
    }
}

async function handleReassignSubmission(e) {
    e.preventDefault();
    if (!reassigningTaskId) return;

    const operator = document.getElementById('reassignOperatorSelect').value;

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/tasks', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: reassigningTaskId,
                action: 'allocateJob',
                operator: operator
            })
        }).then(r => r.json());

        if (res.success) {
            toggleReassignModal(false);
            alert("Saved successfully.");
            await fetchAndRenderTasks();
        } else {
            alert("Failed to assign.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

function handlePartnerJobAllocation(taskId) {
    toggleReassignModal(true, taskId);
}

async function handleStaffReviewSubmission(taskId) {
    if (!confirm("Submit for review?")) return;

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/tasks', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: taskId,
                action: 'submitReview'
            })
        }).then(r => r.json());

        if (res.success) {
            await fetchAndRenderTasks();
        } else {
            alert("Failed to submit.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function handleStaffFilingSubmission(taskId) {
    if (!confirm("Mark this task as Filed?")) return;

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/tasks', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: taskId,
                action: 'markFiled'
            })
        }).then(r => r.json());

        if (res.success) {
            await fetchAndRenderTasks();
        } else {
            alert(res.message || "Failed to file task.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function editPendingReason(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const currentReason = task.reasonForPending || '';
    const newReason = prompt("Enter reason for pending status:", currentReason);

    if (newReason === null) return; // User cancelled

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/tasks', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: taskId,
                action: 'updatePendingReason',
                reason: newReason.trim()
            })
        }).then(r => r.json());

        if (res.success) {
            await fetchAndRenderTasks();
        } else {
            alert(res.message || "Failed to update reason.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

async function handlePartnerReviewVerdict(taskId, isPassed) {
    const index = tasks.findIndex(t => t.id === taskId);
    if (index === -1) return;

    const verdictPrompt = isPassed
        ? "Approve task?"
        : "Reject and send back task?";

    if (!confirm(verdictPrompt)) return;

    showSpinner("Saving...");
    try {
        const res = await authFetch('/api/tasks', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: taskId,
                action: isPassed ? 'verdictApprove' : 'verdictReject'
            })
        }).then(r => r.json());

        if (res.success) {
            await fetchAndRenderTasks();
        } else {
            alert("Failed to submit.");
        }
    } catch (err) {
        alert("Network error.");
    } finally {
        hideSpinner();
    }
}

function standardDateFormatter(str) {
    if (!str) return '-';
    const [y, m, d] = str.split('-');
    return `${d}-${m}-${y}`;
}

async function compileAndRenderIsolatedAnalyticsSuite() {
    let activeNonPartners = usersDB.filter(u => u.role !== 'partner');
    let distributionMap = {};
    activeNonPartners.forEach(u => distributionMap[u.username.toLowerCase()] = 0);
    let leaderboardMap = {};
    activeNonPartners.forEach(u => leaderboardMap[u.username.toLowerCase()] = { name: u.name, score: 0, reworks: 0 });

    try {
        const res = await authFetch('/api/tasks?mode=stats').then(r => r.json());
        if (res.success && res.stats) {
            if (res.stats.operatorCounts) {
                Object.keys(res.stats.operatorCounts).forEach(op => {
                    if (distributionMap[op.toLowerCase()] !== undefined) {
                        distributionMap[op.toLowerCase()] = res.stats.operatorCounts[op];
                    }
                });
            }
            if (Array.isArray(res.stats.leaderboard)) {
                res.stats.leaderboard.forEach(item => {
                    const opKey = (item._id || '').toLowerCase();
                    if (leaderboardMap[opKey]) {
                        leaderboardMap[opKey].score = item.totalFiled || 0;
                        leaderboardMap[opKey].reworks = item.totalReworks || 0;
                    }
                });
            }
        }
    } catch (e) {
        console.error("Failed to load analytics stats:", e);
    }

    const labels = activeNonPartners.map(u => u.name);
    const dataValues = activeNonPartners.map(u => distributionMap[u.username.toLowerCase()]);

    if (allocationPieChartInstance) allocationPieChartInstance.destroy();
    const canvas = document.getElementById('workloadPieChart');
    if (canvas) {
        allocationPieChartInstance = new Chart(canvas.getContext('2d'), {
            type: 'pie',
            data: {
                labels,
                datasets: [{
                    data: dataValues,
                    backgroundColor: ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { boxWidth: 12, font: { size: 11 } }
                    }
                }
            }
        });
    }

    let sorted = Object.values(leaderboardMap).filter(item => item.score > 0);
    sorted.sort((a, b) => (b.score === a.score) ? a.reworks - b.reworks : b.score - a.score);

    const container = document.getElementById('leaderboardContainer');
    if (!container) return;
    container.innerHTML = "";

    if (sorted.length === 0) {
        container.innerHTML = `<div style="text-align:center; font-size:0.8rem; padding:2rem; color:#94a3b8; font-style:italic;">No active completions recorded yet.</div>`;
    } else {
        sorted.forEach((item, idx) => {
            let d = document.createElement('div');
            d.className = "leaderboard-row";
            d.innerHTML = `<div style="display:flex; align-items:center; gap:0.75rem;"><span class="rank-badge rank-${idx + 1}">${idx + 1}</span><span style="font-weight:600;">${item.name}</span></div><div style="font-size:0.8rem; font-weight:500;"><span style="color:var(--success-color); font-weight:700;">${item.score} Closed</span> ${item.reworks > 0 ? `<span style="color:var(--danger-color); font-size:0.75rem; margin-left:0.5rem;">(${item.reworks} Reworks)</span>` : `<span style="color:var(--accent-color); font-size:0.7rem; font-weight:700; margin-left:0.5rem;">⭐ CLEAN CLOSURE</span>`}</div>`;
            container.appendChild(d);
        });
    }
}

function renderSystemDashboardEngine() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    const analyticsTabContent = document.getElementById('analyticsTabContent');
    const adminTabContent = document.getElementById('adminTabContent');
    const masterDataTabContent = document.getElementById('masterDataTabContent');
    const attendanceTabContent = document.getElementById('attendanceTabContent');
    const viewPanel = document.getElementById('viewPanel');
    const leftForms = document.getElementById('leftFormsContainer');
    const mainGrid = document.getElementById('mainGrid');
    const operatorFilterWidget = document.getElementById('operatorFilterWidget');

    // Hide all tab viewports by default
    analyticsTabContent.classList.add('hidden');
    adminTabContent.classList.add('hidden');
    masterDataTabContent.classList.add('hidden');
    attendanceTabContent.classList.add('hidden');
    viewPanel.classList.add('hidden');
    leftForms.classList.add('hidden');
    mainGrid.classList.add('hidden');

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const currentTabBtn = document.getElementById('tab_' + activeTab);
    if (currentTabBtn) currentTabBtn.classList.add('active');

    if (currentUserSession.role === 'partner' && (activeTab === 'allAssigned' || activeTab === 'pendingReview' || activeTab === 'closedArchive')) {
        operatorFilterWidget.classList.remove('hidden');
    } else {
        operatorFilterWidget.classList.add('hidden');
    }

    const canAddTask = (currentUserSession.role === 'partner' && (activeTab === 'allAssigned' || activeTab === 'toBeAssigned')) ||
        (currentUserSession.role !== 'partner' && activeTab === 'myAllocations');

    if (canAddTask) {
        document.getElementById('assignWorkBtn').classList.remove('hidden');
    } else {
        document.getElementById('assignWorkBtn').classList.add('hidden');
    }

    const exportLedgerBtn = document.getElementById('exportLedgerBtn');
    const exportFullLedgerBtn = document.getElementById('exportFullLedgerBtn');
    const isLedgerTab = ['allAssigned', 'toBeAssigned', 'pendingReview', 'closedArchive'].includes(activeTab);

    if (currentUserSession.role === 'partner' && isLedgerTab) {
        if (exportLedgerBtn) exportLedgerBtn.classList.remove('hidden');
        if (exportFullLedgerBtn) exportFullLedgerBtn.classList.remove('hidden');
    } else {
        if (exportLedgerBtn) exportLedgerBtn.classList.add('hidden');
        if (exportFullLedgerBtn) exportFullLedgerBtn.classList.add('hidden');
    }

    if (activeTab === 'analyticsSuite') {
        analyticsTabContent.classList.remove('hidden');
        compileAndRenderIsolatedAnalyticsSuite();
        return;
    } else if (activeTab === 'adminCenter') {
        adminTabContent.classList.remove('hidden');
        renderPartnerAdminCenterViewports();
        return;
    } else if (activeTab === 'masterData') {
        masterDataTabContent.classList.remove('hidden');
        renderPartnerMasterDataViewports();
        return;
    } else if (activeTab === 'attendanceLogs') {
        attendanceTabContent.classList.remove('hidden');
        renderPartnerAttendanceLogsViewport();
        return;
    } else {
        mainGrid.classList.remove('hidden');
        viewPanel.classList.remove('hidden');
        leftForms.classList.add('hidden');
        mainGrid.classList.remove('split');
    }

    // Fetch tasks from server with current filters and render
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; padding:4rem; color:#94a3b8; font-style:italic;">Loading tasks...</td></tr>`;
    fetchAndRenderTasks();
}

// Render task table body using the pre-fetched tasks array (populated by fetchAndRenderTasks)
function renderTaskTableBody() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    const totalTasks = tasksTotalCount;
    const taskPageSize = 25;
    const totalTaskPages = tasksTotalPages;
    if (taskCurrentPage > totalTaskPages) {
        taskCurrentPage = totalTaskPages;
    }
    const taskStartIndex = (taskCurrentPage - 1) * taskPageSize;

    document.getElementById('tableTitleDisplay').innerText = "Records: (" + totalTasks + ")";
    tasks.forEach((task, index) => {
        const tr = document.createElement('tr');
        const isUrgent = (new Date(task.dueDate) <= new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)) && (task.currentStatus !== 'Filed');
        const dynamicRowClass = isUrgent ? 'critical-delay' : '';
        const relativeIndex = index + taskStartIndex + 1;

        let user = usersDB.find(u => u.username === task.workTakenBy);
        let operatorDisplayName = user ? user.name : `<span style="color:#94a3b8; font-style:italic;">Pool</span>`;
        let actionCellHtml = '<td data-label="Actions">-</td>';

        let crudsHtml = '';
        if (currentUserSession.role === 'partner') {
            crudsHtml = `
                <button class="action-btn btn-secondary" onclick="editTaskProfile(${task.id})">Edit</button>
                <button class="action-btn btn-danger" onclick="deleteTaskRecord(${task.id})">Delete</button>
            `;
        } else if (task.workTakenBy === currentUserSession.username && task.currentStatus !== 'Filed') {
            crudsHtml = `
                <button class="action-btn btn-secondary" onclick="editTaskProfile(${task.id})">Edit</button>
            `;
        }

        if(task.currentStatus === 'Filed') { 
            actionCellHtml = `<td data-label="Actions"><div class="action-group"><span class="lock-badge">Filed</span>${crudsHtml}</div></td>`; 
        } else {
            const filedBtn = `<button class="action-btn btn-success" onclick="handleStaffFilingSubmission(${task.id})">Filed</button>`;
            if(currentUserSession.role === 'partner') {
                if(task.currentStatus === 'Unassigned') {
                    actionCellHtml = `<td data-label="Actions"><div class="action-group">${filedBtn}<button class="action-btn btn-primary" onclick="handlePartnerJobAllocation(${task.id})">Assign</button>${crudsHtml}</div></td>`;
                } else if(task.currentStatus === 'Assigned' || task.currentStatus === 'Approved') {
                    actionCellHtml = `<td data-label="Actions"><div class="action-group">${filedBtn}<button class="action-btn btn-warning" onclick="handlePartnerJobAllocation(${task.id})">Reassign</button>${crudsHtml}</div></td>`;
                } else if(task.currentStatus === 'Pending Review') {
                    actionCellHtml = `<td data-label="Actions"><div class="action-group">${filedBtn}<button class="action-btn btn-success" onclick="handlePartnerReviewVerdict(${task.id}, true)">Approve</button><button class="action-btn btn-danger" onclick="handlePartnerReviewVerdict(${task.id}, false)">Reject</button>${crudsHtml}</div></td>`;
                } else {
                    actionCellHtml = `<td data-label="Actions"><div class="action-group">${filedBtn}${crudsHtml}</div></td>`;
                }
            } else {
                if(task.currentStatus === 'Unassigned') {
                    actionCellHtml = `<td data-label="Actions"><div class="action-group">${filedBtn}${crudsHtml}</div></td>`;
                } else if(task.currentStatus === 'Assigned' || task.currentStatus === 'Approved') {
                    actionCellHtml = `<td data-label="Actions"><div class="action-group">${filedBtn}<button class="action-btn btn-secondary" onclick="handleStaffReviewSubmission(${task.id})">Submit for Review</button>${crudsHtml}</div></td>`;
                } else if(task.currentStatus === 'Pending Review') {
                    actionCellHtml = `<td data-label="Actions"><div class="action-group">${filedBtn}<span style="font-style:italic; color:#64748b; font-weight:600;">Pending Review</span>${crudsHtml}</div></td>`;
                } else {
                    actionCellHtml = `<td data-label="Actions"><div class="action-group">${filedBtn}${crudsHtml}</div></td>`;
                }
            }
        }

        let datePickerCell = (currentUserSession.role === 'partner' && task.currentStatus !== 'Filed')
            ? `<input type="date" class="date-editor" value="${task.dueDate}" onchange="handlePartnerInlineDateChange(${task.id}, this.value)">`
            : standardDateFormatter(task.dueDate);

        const reasonVal = task.reasonForPending || '';
        const canEditReason = (task.currentStatus !== 'Filed') &&
            (currentUserSession.role === 'partner' || task.workTakenBy === currentUserSession.username);

        let reasonCellHtml = '';
        if (canEditReason) {
            reasonCellHtml = `<td data-label="Reason"><div style="display:flex; align-items:center; gap:0.5rem; justify-content:space-between;"><span>${reasonVal}</span><button class="action-btn btn-secondary" style="padding:0.2rem 0.4rem; font-size:0.75rem; margin:0;" onclick="editPendingReason(${task.id})">Edit</button></div></td>`;
        } else {
            reasonCellHtml = `<td data-label="Reason">${reasonVal}</td>`;
        }

        const ayDisplay = task.assessmentYear ? `<span style="font-weight:600; color:#475569;">${task.assessmentYear}</span>` : '-';
        tr.innerHTML = `<td data-label="No">${relativeIndex}</td><td data-label="ID" style="font-weight:700; color:#475569;">#${task.clientCode}</td><td data-label="Client" style="font-weight:600; color:var(--primary-color);">${task.clientName}</td><td data-label="Type">${task.natureOfWork}</td><td data-label="AY">${ayDisplay}</td><td data-label="Received">${standardDateFormatter(task.dateReceived)}</td><td data-label="Due" class="${dynamicRowClass}">${datePickerCell}</td><td data-label="Operator" style="font-weight:500;">${operatorDisplayName}</td><td data-label="Started">${standardDateFormatter(task.workTakenOn)}</td><td data-label="Status"><div class="status-cell-wrapper"><span class="status status-${task.currentStatus.toLowerCase().replace(/ /g, '-')}">${task.currentStatus}</span>${task.sendBackCount > 0 ? `<span style="color:var(--danger-color); font-size:0.7rem; font-weight:bold; margin-top:2px;">(Reworked x${task.sendBackCount})</span>` : ''}</div></td>${reasonCellHtml}${actionCellHtml}`;
        tbody.appendChild(tr);
    });

    if (tasks.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; padding:4rem; color:#94a3b8; font-style:italic;">No tasks found.</td></tr>`;
    }

    const taskPagination = document.getElementById('taskPaginationContainer');
    if (taskPagination) {
        taskPagination.innerHTML = `
            <div style="color: #475569; font-weight: 500; font-size: 0.9rem;">Showing ${totalTasks === 0 ? 0 : taskStartIndex + 1} to ${Math.min(taskStartIndex + taskPageSize, totalTasks)} of ${totalTasks} tasks</div>
            <div style="display:flex; gap:0.5rem; align-items: center;">
                <button class="action-btn btn-secondary" ${taskCurrentPage === 1 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeTaskPage(${taskCurrentPage - 1})">Prev</button>
                <span style="font-weight:600; padding:0 0.5rem; color: var(--primary-color); font-size: 0.9rem;">Page ${taskCurrentPage} of ${totalTaskPages}</span>
                <button class="action-btn btn-secondary" ${taskCurrentPage === totalTaskPages ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeTaskPage(${taskCurrentPage + 1})">Next</button>
            </div>
        `;
    }
}

function renderPartnerMasterDataViewports() {
    fetchAndRenderClients();
    renderEngagementGrid();
}

function renderClientTableBody() {
    const totalClients = clientsTotalCount;
    const totalPages = clientsTotalPages;
    const startIndex = (clientCurrentPage - 1) * 10;

    const clientTbody = document.getElementById('masterClientTableBody');
    if (!clientTbody) return;
    clientTbody.innerHTML = "";
    clientMaster.forEach(c => {
        let tr = document.createElement('tr');
        tr.innerHTML = `
            <td data-label="ID" style="font-weight:700; color:var(--secondary-color);">#${c.id}</td>
            <td data-label="Name" style="font-weight:600; color:var(--primary-color);">${c.name}</td>
            <td data-label="PAN" style="font-family:monospace; font-size:0.9rem;">${c.pan || '-'}</td>
            <td data-label="Phone">${c.contact || '-'}</td>
            <td data-label="Email">${c.email || '-'}</td>
            <td data-label="Actions">
                <div class="action-group">
                    <button class="action-btn btn-primary" onclick="viewClientDetails(${c.id})">Details</button>
                    <button class="action-btn btn-secondary" onclick="editClientProfile(${c.id})">Edit</button>
                    <button class="action-btn btn-danger" onclick="administrativeExecuteDeleteClient(${c.id})">Delete</button>
                </div>
            </td>
        `;
        clientTbody.appendChild(tr);
    });

    if (clientMaster.length === 0) {
        clientTbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:2rem; color:#94a3b8; font-style:italic;">No clients found.</td></tr>`;
    }

    const paginationContainer = document.getElementById('clientPaginationContainer');
    if (paginationContainer) {
        paginationContainer.innerHTML = `
            <div style="color: #475569; font-weight: 500;">Showing ${totalClients === 0 ? 0 : startIndex + 1} to ${Math.min(startIndex + 10, totalClients)} of ${totalClients} clients</div>
            <div style="display:flex; gap:0.5rem; align-items: center;">
                <button class="action-btn btn-secondary" ${clientCurrentPage === 1 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeClientPage(${clientCurrentPage - 1})">Prev</button>
                <span style="font-weight:600; padding:0 0.5rem; color: var(--primary-color);">Page ${clientCurrentPage} of ${totalPages}</span>
                <button class="action-btn btn-secondary" ${clientCurrentPage === totalPages ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeClientPage(${clientCurrentPage + 1})">Next</button>
            </div>
        `;
    }
}

function renderEngagementGrid() {

    const engGrid = document.getElementById('masterEngagementGrid');
    engGrid.innerHTML = "";
    engagementMaster.forEach((eng, idx) => {
        let div = document.createElement('div');
        div.className = "engagement-item";
        let actionsHtml = '';
        if (currentUserSession.role === 'partner') {
            actionsHtml = `
                <div class="action-group">
                    <button class="action-btn btn-secondary" onclick="editEngagementType('${eng}')">Edit</button>
                    <button class="action-btn btn-danger" onclick="administrativeExecuteDeleteEngagement('${eng}')">Delete</button>
                </div>
            `;
        } else {
            actionsHtml = '<span style="color:#94a3b8;">-</span>';
        }
        div.innerHTML = `
            <div class="engagement-info">
                <span class="engagement-index">${idx + 1}.</span>
                <span class="engagement-title">${eng}</span>
            </div>
            <div class="engagement-actions">
                ${actionsHtml}
            </div>
        `;
        engGrid.appendChild(div);
    });

    // Hide add engagement button for non-partners
    const addEngBtn = document.querySelector("#masterDataTabContent button[onclick*='toggleEngagementModal']");
    if (addEngBtn) {
        if (currentUserSession.role === 'partner') addEngBtn.classList.remove('hidden');
        else addEngBtn.classList.add('hidden');
    }
}

function renderPartnerAdminCenterViewports() {
    if (currentUserSession.role !== 'partner') return;

    let filteredUsers = usersDB;
    if (userSearchQuery) {
        filteredUsers = usersDB.filter(u =>
            u.name.toLowerCase().includes(userSearchQuery) ||
            u.username.toLowerCase().includes(userSearchQuery) ||
            u.role.toLowerCase().includes(userSearchQuery)
        );
    }

    const tbody = document.getElementById('adminUserTableBody');
    if (!tbody) return;
    tbody.innerHTML = "";

    filteredUsers.forEach(u => {
        const tr = document.createElement('tr');

        const signatureStatus = u.faceDescriptor
            ? `<span style="color:var(--success-color); font-weight:700;">Yes</span>`
            : `<span style="color:#94a3b8; font-style:italic;">No</span>`;

        let faceActionHtml = '';
        if (u.faceDescriptor) {
            faceActionHtml = `<button class="action-btn btn-warning" onclick="resetUserFace('${u.username}')">Reset</button>`;
        } else {
            faceActionHtml = `<button class="action-btn btn-primary" onclick="registerUserFace('${u.username}')">Register</button>`;
        }

        const isSelf = u.username === currentUserSession.username;
        const crudActionHtml = `
            <button class="action-btn btn-secondary" onclick="editUserAccount('${u.username}')">Edit</button>
            ${isSelf ? '' : `<button class="action-btn btn-danger" onclick="deleteUserAccount('${u.username}')">Delete</button>`}
        `;

        tr.innerHTML = `
            <td data-label="Name" style="font-weight:600; color:var(--primary-color);">${u.name}</td>
            <td data-label="Username" style="font-family:monospace;">${u.username}</td>
            <td data-label="Role" style="text-transform: capitalize; font-weight:500;">${u.role}</td>
            <td data-label="Face Registry">${signatureStatus}</td>
            <td data-label="Actions">
                <div class="action-group">
                    ${faceActionHtml}
                    ${crudActionHtml}
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    if (filteredUsers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:2rem; color:#94a3b8; font-style:italic;">No users found.</td></tr>`;
    }

    // Fetch and render Security Audit Logs (Paginated & Searchable on server)
    renderAuditLogsViewport();
}

// Client Picker Modal logic
function toggleClientPickerModal(shouldShow, targetInputId) {
    const overlay = document.getElementById('clientPickerModalOverlay');
    if (!overlay) return;

    if (shouldShow) {
        activeClientPickerTarget = targetInputId;
        clientPickerSearchQuery = '';
        document.getElementById('clientPickerSearch').value = '';
        renderClientPickerList();
        overlay.classList.remove('hidden');
        document.getElementById('clientPickerSearch').focus();
    } else {
        overlay.classList.add('hidden');
        activeClientPickerTarget = null;
    }
}

let pickerClientCache = [];
let _clientPickerDebounce = null;

function handleClientPickerSearch(val) {
    clientPickerSearchQuery = val.trim();
    clearTimeout(_clientPickerDebounce);
    _clientPickerDebounce = setTimeout(() => {
        renderClientPickerList();
    }, 250);
}

async function renderClientPickerList() {
    const tbody = document.getElementById('clientPickerTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:2rem; color:#94a3b8; font-style:italic;">Searching clients...</td></tr>';

    const params = new URLSearchParams({ limit: 50 });
    if (clientPickerSearchQuery) params.set('search', clientPickerSearchQuery);

    try {
        const res = await authFetch(`/api/clients?${params}`).then(r => r.json());
        if (res.success) {
            pickerClientCache = res.clients;
        } else {
            pickerClientCache = [];
        }
    } catch (e) {
        pickerClientCache = [];
    }

    tbody.innerHTML = '';
    pickerClientCache.forEach(c => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td data-label="ID" style="font-weight:700;">#${c.id}</td>
            <td data-label="Name" style="font-weight:600; color:var(--primary-color);">${c.name}</td>
            <td data-label="PAN" style="font-family:monospace;">${c.pan || '-'}</td>
            <td data-label="Phone">${c.contact || '-'}</td>
            <td data-label="Action">
                <button class="action-btn btn-primary" type="button" onclick="selectClientFromPicker(${c.id})">Select</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    if (pickerClientCache.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:2rem; color:#94a3b8; font-style:italic;">No clients found matching the query.</td></tr>`;
    }
}

function selectClientFromPicker(clientId) {
    const client = pickerClientCache.find(c => c.id === clientId) || clientMaster.find(c => c.id === clientId);
    if (!client || !activeClientPickerTarget) return;

    const hiddenInput = document.getElementById(activeClientPickerTarget);
    const displayInput = document.getElementById(activeClientPickerTarget + '_display');

    if (hiddenInput) {
        hiddenInput.value = JSON.stringify({ id: client.id, name: client.name });
        const changeEvent = new Event('change', { bubbles: true });
        hiddenInput.dispatchEvent(changeEvent);
    }

    if (displayInput) {
        displayInput.value = `[#${client.id}] ${client.name}`;
    }

    toggleClientPickerModal(false);
}

// Normalize dates from database/excel to YYYY-MM-DD for HTML5 date inputs
function formatDateForInput(dateStr) {
    if (!dateStr) return "";
    dateStr = String(dateStr).trim();
    if (dateStr.toLowerCase() === 'nan') return "";

    // Handle timestamp strings like "1990-08-15 00:00:00" or "1990-08-15T00:00:00.000Z"
    if (dateStr.includes(" ") || dateStr.includes("T")) {
        const parts = dateStr.split(/[ T]/);
        if (parts[0] && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
            return parts[0];
        }
    }

    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return dateStr;
    }

    // Handle DD-MM-YYYY or DD/MM/YYYY
    const separator = dateStr.includes("-") ? "-" : (dateStr.includes("/") ? "/" : null);
    if (separator) {
        const parts = dateStr.split(separator);
        if (parts.length === 3) {
            // DD-MM-YYYY
            if (parts[2].length === 4 && parts[0].length <= 2 && parts[1].length <= 2) {
                const dd = parts[0].padStart(2, '0');
                const mm = parts[1].padStart(2, '0');
                const yyyy = parts[2];
                return `${yyyy}-${mm}-${dd}`;
            }
            // YYYY-MM-DD (e.g. from slash separator)
            if (parts[0].length === 4 && parts[1].length <= 2 && parts[2].length <= 2) {
                const yyyy = parts[0];
                const mm = parts[1].padStart(2, '0');
                const dd = parts[2].padStart(2, '0');
                return `${yyyy}-${mm}-${dd}`;
            }
        }
    }

    // General parse fallback
    try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        }
    } catch (e) { }

    return "";
}

// Client Details Modal Controllers
function toggleClientDetailsModal(shouldShow) {
    const overlay = document.getElementById('clientDetailsModalOverlay');
    if (!overlay) return;
    if (shouldShow) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

function viewClientDetails(clientId) {
    const client = clientMaster.find(c => c.id === clientId);
    if (!client) return;

    const container = document.getElementById('clientDetailsDisplayContainer');
    if (!container) return;

    container.innerHTML = `
        <div class="details-group"><div class="details-label">Client ID</div><div class="details-value">#${client.id}</div></div>
        <div class="details-group"><div class="details-label">Name</div><div class="details-value">${client.name || '-'}</div></div>
        <div class="details-group"><div class="details-label">PAN</div><div class="details-value" style="font-family:monospace;">${client.pan || '-'}</div></div>
        <div class="details-group"><div class="details-label">Phone</div><div class="details-value">${client.contact || '-'}</div></div>
        <div class="details-group"><div class="details-label">Email</div><div class="details-value">${client.email || '-'}</div></div>
        <div class="details-group"><div class="details-label">Password of Intimation / ITR-V</div><div class="details-value">${client.passwordITR || '-'}</div></div>
        <div class="details-group"><div class="details-label">Tax-Audit Case</div><div class="details-value">${client.taxAuditCase || '-'}</div></div>
        <div class="details-group"><div class="details-label">DOB / DOI / DOF</div><div class="details-value">${standardDateFormatter(client.dob)}</div></div>
        <div class="details-group"><div class="details-label">Address</div><div class="details-value">${client.address || '-'}</div></div>
        <div class="details-group"><div class="details-label">Area / Locality</div><div class="details-value">${client.area || '-'}</div></div>
        <div class="details-group"><div class="details-label">City</div><div class="details-value">${client.city || '-'}</div></div>
        <div class="details-group"><div class="details-label">PIN / ZIP Code</div><div class="details-value">${client.pinCode || '-'}</div></div>
        <div class="details-group"><div class="details-label">Aadhaar No.</div><div class="details-value">${client.aadhaar || '-'}</div></div>
        <div class="details-group"><div class="details-label">Status</div><div class="details-value">${client.status || '-'}</div></div>
        <div class="details-group" style="grid-column: span 2; border-bottom: 2px solid var(--accent-color); margin-top: 0.5rem;"><div class="details-label" style="color:var(--accent-color); font-weight:bold;">GST Registration Details</div></div>
        <div class="details-group"><div class="details-label">GST Number</div><div class="details-value">${client.gstNumber || '-'}</div></div>
        <div class="details-group"><div class="details-label">GST Type</div><div class="details-value" style="text-transform: uppercase;">${client.gstType || '-'}</div></div>
        <div class="details-group"><div class="details-label">GST Username</div><div class="details-value">${client.gstUsername || '-'}</div></div>
        <div class="details-group"><div class="details-label">GST Password</div><div class="details-value">${client.gstPassword || '-'}</div></div>
        <div class="details-group"><div class="details-label">Assigned Staff</div><div class="details-value">${client.gstStaff || '-'}</div></div>
        <div class="details-group"><div class="details-label">GST Mobile No</div><div class="details-value">${client.gstMobileNo || '-'}</div></div>
        <div class="details-group"><div class="details-label">Contact Person</div><div class="details-value">${client.gstContactPerson || '-'}</div></div>
        <div class="details-group" style="grid-column: span 2;"><div class="details-label">GST Email ID</div><div class="details-value">${client.gstEmail || '-'}</div></div>
    `;

    toggleClientDetailsModal(true);
}

// Global browser hash change listener for back/forward navigation
window.addEventListener('hashchange', () => {
    if (currentUserSession) {
        const currentHash = window.location.hash.substring(1);
        const partnerTabs = ['toBeAssigned', 'allAssigned', 'pendingReview', 'closedArchive', 'masterData', 'attendanceLogs', 'analyticsSuite', 'adminCenter'];
        const staffTabs = ['myAllocations', 'myClosed', 'masterData'];
        const allowedTabs = currentUserSession.role === 'partner' ? partnerTabs : staffTabs;

        if (allowedTabs.includes(currentHash) && activeTab !== currentHash) {
            switchActiveTab(currentHash);
        }
    }
});

function changeTaskPage(page) {
    taskCurrentPage = page;
    renderSystemDashboardEngine();
}

function handleAttendanceFilterModeChange() {
    const mode = document.getElementById('attendanceViewMode').value;
    const dateInput = document.getElementById('attendanceFilterDate');
    const monthInput = document.getElementById('attendanceFilterMonth');

    if (mode === 'daily') {
        if (dateInput) dateInput.classList.remove('hidden');
        if (monthInput) monthInput.classList.add('hidden');
    } else {
        if (dateInput) dateInput.classList.add('hidden');
        if (monthInput) monthInput.classList.remove('hidden');
    }
    attendanceCurrentPage = 1;
    renderPartnerAttendanceLogsViewport();
}

function handleAttendanceFilterChange() {
    attendanceCurrentPage = 1;
    renderPartnerAttendanceLogsViewport();
}

function changeAttendancePage(page) {
    attendanceCurrentPage = page;
    renderPartnerAttendanceLogsViewport();
}

let _auditSearchDebounce = null;

async function renderAuditLogsViewport() {
    const auditTbody = document.getElementById('adminAuditLogTableBody');
    if (!auditTbody) return;

    auditTbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:#94a3b8; font-style:italic;">Loading audit logs...</td></tr>`;

    const params = new URLSearchParams({
        page: auditCurrentPage,
        limit: 10
    });
    if (auditSearchQuery) params.set('search', auditSearchQuery);

    try {
        const res = await authFetch(`/api/audit?${params}`).then(r => r.json());
        if (res.success) {
            auditLogsMaster = res.logs || [];
            auditTotalCount = res.totalCount || 0;
            auditTotalPages = res.totalPages || 1;
        } else {
            auditLogsMaster = [];
            auditTotalCount = 0;
            auditTotalPages = 1;
        }
    } catch (err) {
        auditLogsMaster = [];
    }

    const totalLogs = auditTotalCount;
    const pageSize = 10;
    const totalPages = auditTotalPages;
    const startIndex = (auditCurrentPage - 1) * pageSize;

    auditTbody.innerHTML = "";

    auditLogsMaster.forEach(log => {
        const tr = document.createElement('tr');
        const ts = new Date(log.timestamp).toLocaleString('en-IN');
        let detailsStr = '';
        try {
            detailsStr = typeof log.details === 'object' ? JSON.stringify(log.details) : String(log.details);
        } catch (e) {
            detailsStr = String(log.details);
        }
        tr.innerHTML = `
            <td data-label="Timestamp" style="white-space: nowrap;">${ts}</td>
            <td data-label="Actor" style="font-weight:600;">${log.actor}</td>
            <td data-label="Action"><span class="status status-assigned" style="text-transform:uppercase; font-size:0.75rem;">${log.action}</span></td>
            <td data-label="Details" style="font-family:monospace; font-size:0.8rem; max-width: 300px; word-break: break-all;">${detailsStr}</td>
        `;
        auditTbody.appendChild(tr);
    });

    if (auditLogsMaster.length === 0) {
        auditTbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:2rem; color:#94a3b8; font-style:italic;">No audit events found.</td></tr>`;
    }

    const paginationContainer = document.getElementById('auditPaginationContainer');
    if (paginationContainer) {
        paginationContainer.innerHTML = `
            <div style="color: #475569; font-weight: 500; font-size: 0.9rem;">Showing ${totalLogs === 0 ? 0 : startIndex + 1} to ${Math.min(startIndex + pageSize, totalLogs)} of ${totalLogs} entries</div>
            <div style="display:flex; gap:0.5rem; align-items: center;">
                <button class="action-btn btn-secondary" ${auditCurrentPage === 1 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeAuditPage(${auditCurrentPage - 1})">Prev</button>
                <span style="font-weight:600; padding:0 0.5rem; color: var(--primary-color); font-size: 0.9rem;">Page ${auditCurrentPage} of ${totalPages}</span>
                <button class="action-btn btn-secondary" ${auditCurrentPage === totalPages ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeAuditPage(${auditCurrentPage + 1})">Next</button>
            </div>
        `;
    }
}

function handleAuditSearch(val) {
    auditSearchQuery = val.trim().toLowerCase();
    auditCurrentPage = 1;
    clearTimeout(_auditSearchDebounce);
    _auditSearchDebounce = setTimeout(() => {
        renderAuditLogsViewport();
    }, 300);
}

function changeAuditPage(page) {
    auditCurrentPage = page;
    renderAuditLogsViewport();
}

