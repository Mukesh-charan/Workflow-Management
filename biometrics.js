// Auth-aware fetch helper
async function authFetch(url, options = {}) {
    const token = sessionStorage.getItem('ca_secure_active_token');
    options.headers = options.headers || {};
    if (token) {
        options.headers['Authorization'] = `Bearer ${token}`;
    }
    
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }

    const res = await fetch(url, options);

    if (res.status === 401) {
        alert("Session expired. Please log in again.");
        handleSecureSignout();
        throw new Error("Unauthorized");
    }

    return res;
}

// Biometric webcam scanning variables
let biometricStream = null;
let detectionInterval = null;
let biometricMode = 'verify'; // 'verify' or 'register'
let targetRegisterUsername = null;
let temporaryAuthSession = null; // Stash login info during face checks
let kioskTargetDescriptor = null; // Stash target face descriptor for kiosk mode verification

async function loadFaceApiScript() {
    return new Promise((resolve, reject) => {
        if (window.faceapi) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js';
        script.onload = async () => {
            try {
                showSpinner("Loading Facial Scanner AI...");
                await Promise.all([
                    faceapi.nets.tinyFaceDetector.loadFromUri('./models'),
                    faceapi.nets.faceLandmark68Net.loadFromUri('./models'),
                    faceapi.nets.faceRecognitionNet.loadFromUri('./models')
                ]);
                hideSpinner();
                resolve();
            } catch (err) {
                hideSpinner();
                alert("Could not load face weights: " + (err.message || err) + "\nCheck browser console (F12) -> Network tab to view the failing request details.");
                reject(err);
            }
        };
        script.onerror = () => {
            alert("Could not load face-api script file from jsDelivr CDN.");
            reject(new Error("CDN Load Error"));
        };
        document.head.appendChild(script);
    });
}

function findBestFaceMatch(capturedDescriptor) {
    let bestMatch = null;
    let minDistance = 1.0;

    const usersWithFaces = usersDB.filter(u => u.role !== 'partner' && u.faceDescriptor);

    usersWithFaces.forEach(u => {
        const stored = u.faceDescriptor;
        const targetArr = Array.isArray(stored) ? stored : Object.values(stored || {});
        if (targetArr.length === 128) {
            const dist = faceapi.euclideanDistance(capturedDescriptor, targetArr);
            if (dist < minDistance) {
                minDistance = dist;
                bestMatch = u;
            }
        }
    });

    return { bestMatch, minDistance };
}

// WebRTC Face Scanning Controls
async function startBiometricScan(mode, username, storedDescriptor) {
    biometricMode = mode;
    targetRegisterUsername = username;
    kioskTargetDescriptor = storedDescriptor;
    
    showSpinner("Starting Secure Camera...");
    try {
        await loadFaceApiScript();
        
        const video = document.getElementById('biometricVideo');
        const canvas = document.getElementById('biometricCanvas');
        
        // Reset capture button
        document.getElementById('biometricActionButton').style.display = 'none';

        // Get User Media Webcam Stream
        biometricStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 240, facingMode: 'user' }
        });
        video.srcObject = biometricStream;
        
        document.getElementById('biometricModal').classList.remove('hidden');
        let titleText = "Face Scan";
        if (mode === 'register') {
            titleText = "Register Face";
        } else if (mode === 'auto_clockIn') {
            titleText = "Biometric Terminal (Clock In)";
        } else if (mode === 'auto_clockOut') {
            titleText = "Biometric Terminal (Clock Out)";
        }
        document.getElementById('biometricModalTitle').innerText = titleText;
        document.getElementById('biometricStatusMsg').innerText = "Align face.";
        document.getElementById('biometricStatusMsg').style.color = "#38bdf8";
        
        // Clear any previous overlay drawing
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, canvas.width, canvas.height);
        
        video.onplay = () => {
            const displaySize = { width: video.videoWidth || 320, height: video.videoHeight || 240 };
            canvas.width = displaySize.width;
            canvas.height = displaySize.height;
            faceapi.matchDimensions(canvas, displaySize);
            
            // Show capture action button for manual scans
            const actionButton = document.getElementById('biometricActionButton');
            actionButton.style.display = 'inline-block';
            if (mode === 'register') {
                actionButton.innerText = "Save";
            } else {
                actionButton.innerText = "Verify";
            }
        };

        // Initialize facial scanning loop
        let faceDetectedTime = 0;
        
        detectionInterval = setInterval(async () => {
            if (video.paused || video.ended) return;
            
            const detections = await faceapi.detectSingleFace(
                video, 
                new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.35 })
            ).withFaceLandmarks().withFaceDescriptor();
            
            context.clearRect(0, 0, canvas.width, canvas.height);
            
            if (detections) {
                const displaySize = { width: video.videoWidth || 320, height: video.videoHeight || 240 };
                const resizedDetections = faceapi.resizeResults(detections, displaySize);
                
                // Draw face landmarks to show visually active scanner
                faceapi.draw.drawFaceLandmarks(canvas, resizedDetections.landmarks);
                
                document.getElementById('biometricStatusMsg').innerText = "Scanning...";
                document.getElementById('biometricStatusMsg').style.color = "#10b981";
                
                // Stash latest detection for manual capture button clicks
                video.latestDetection = detections;

                if (mode === 'verify' && storedDescriptor) {
                    const targetArr = Array.isArray(storedDescriptor) ? storedDescriptor : Object.values(storedDescriptor);
                    if (targetArr.length === 128) {
                        const dist = faceapi.euclideanDistance(detections.descriptor, targetArr);
                        if (dist < 0.6) {
                            clearInterval(detectionInterval);
                            document.getElementById('biometricStatusMsg').innerText = "Verified!";
                            document.getElementById('biometricStatusMsg').style.color = "#10b981";
                            setTimeout(async () => {
                                cancelBiometricVerification();
                                if (temporaryAuthSession) {
                                    await completeSessionAccess(temporaryAuthSession.user);
                                    temporaryAuthSession = null;
                                }
                            }, 1500);
                        }
                    }
                } else if (mode.startsWith('kiosk_') && storedDescriptor) {
                    const targetArr = Array.isArray(storedDescriptor) ? storedDescriptor : Object.values(storedDescriptor);
                    if (targetArr.length === 128) {
                        const dist = faceapi.euclideanDistance(detections.descriptor, targetArr);
                        if (dist < 0.6) {
                            clearInterval(detectionInterval);
                            await handleKioskSuccess(username, mode);
                        }
                    }
                } else if (mode.startsWith('auto_')) {
                    const matchResult = findBestFaceMatch(detections.descriptor);
                    if (matchResult.bestMatch && matchResult.minDistance < 0.55) {
                        clearInterval(detectionInterval);
                        document.getElementById('biometricStatusMsg').innerText = `Matched: ${matchResult.bestMatch.name}!`;
                        document.getElementById('biometricStatusMsg').style.color = "#10b981";
                        const actionType = mode.split('_')[1];
                        setTimeout(async () => {
                            await handleKioskSuccess(matchResult.bestMatch.username, 'kiosk_' + actionType);
                        }, 1000);
                    } else {
                        document.getElementById('biometricStatusMsg').innerText = "Face Not Recognized";
                        document.getElementById('biometricStatusMsg').style.color = "#ef4444";
                    }
                } else if (mode === 'register') {
                    // Automatically capture and register face descriptor after 1.5 seconds of continuous detection
                    faceDetectedTime += 250;
                    if (faceDetectedTime >= 1500) {
                        clearInterval(detectionInterval);
                        document.getElementById('biometricStatusMsg').innerText = "Captured!";
                        document.getElementById('biometricStatusMsg').style.color = "#10b981";
                        setTimeout(async () => {
                            await saveFaceDescriptorToCloud(username, Array.from(detections.descriptor));
                        }, 1000);
                    }
                }
            } else {
                faceDetectedTime = 0;
                video.latestDetection = null;
                document.getElementById('biometricStatusMsg').innerText = "Align face.";
                document.getElementById('biometricStatusMsg').style.color = "#38bdf8";
            }
        }, 250);
        
        hideSpinner();
    } catch (err) {
        console.error("Camera access or scanning error:", err);
        hideSpinner();
        alert("Camera access error.");
        cancelBiometricVerification();
    }
}

async function triggerBiometricAction() {
    const video = document.getElementById('biometricVideo');
    if (!video || video.paused || video.ended) return;

    showSpinner(biometricMode === 'register' ? "Registering Face Profile..." : "Checking Face Registry...");
    try {
        let detections = video.latestDetection;

        // Try immediate high-precision fallback detection on demand
        if (!detections) {
            detections = await faceapi.detectSingleFace(
                video, 
                new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 })
            ).withFaceLandmarks().withFaceDescriptor();
        }

        if (!detections) {
            hideSpinner();
            alert("No face detected. Please position your face clearly in the camera frame and try again.");
            return;
        }

        if (biometricMode === 'register') {
            if (detectionInterval) clearInterval(detectionInterval);
            hideSpinner();
            await saveFaceDescriptorToCloud(targetRegisterUsername, Array.from(detections.descriptor));
        } else if (biometricMode === 'verify') {
            const stored = temporaryAuthSession ? temporaryAuthSession.faceDescriptor : null;
            const targetArr = Array.isArray(stored) ? stored : Object.values(stored || {});
            if (!stored || targetArr.length !== 128) {
                hideSpinner();
                alert("No facial profile is enrolled for this account.");
                cancelBiometricVerification();
                return;
            }

            const dist = faceapi.euclideanDistance(detections.descriptor, targetArr);
            hideSpinner();

            if (dist < 0.6) {
                if (detectionInterval) clearInterval(detectionInterval);
                document.getElementById('biometricStatusMsg').innerText = "Access Verified! Logging in...";
                document.getElementById('biometricStatusMsg').style.color = "#10b981";
                setTimeout(async () => {
                    cancelBiometricVerification();
                    if (temporaryAuthSession) {
                        await completeSessionAccess(temporaryAuthSession.user);
                        temporaryAuthSession = null;
                    }
                }, 1000);
            } else {
                alert(`Face verification failed.\nMatch Distance: ${dist.toFixed(2)} (Target Threshold is 0.60).\n\nPlease ensure proper lighting and align your face correctly.`);
            }
        } else if (biometricMode.startsWith('kiosk_')) {
            const targetArr = Array.isArray(kioskTargetDescriptor) ? kioskTargetDescriptor : Object.values(kioskTargetDescriptor || {});
            if (!kioskTargetDescriptor || targetArr.length !== 128) {
                hideSpinner();
                alert("No facial profile is enrolled for this account.");
                cancelBiometricVerification();
                return;
            }

            const dist = faceapi.euclideanDistance(detections.descriptor, targetArr);
            hideSpinner();

            if (dist < 0.6) {
                if (detectionInterval) clearInterval(detectionInterval);
                await handleKioskSuccess(targetRegisterUsername, biometricMode);
            } else {
                alert(`Face verification failed.\nMatch Distance: ${dist.toFixed(2)} (Target Threshold is 0.60).\n\nPlease ensure proper lighting and align your face correctly.`);
            }
        } else if (biometricMode.startsWith('auto_')) {
            const matchResult = findBestFaceMatch(detections.descriptor);
            hideSpinner();

            if (matchResult.bestMatch && matchResult.minDistance < 0.55) {
                if (detectionInterval) clearInterval(detectionInterval);
                document.getElementById('biometricStatusMsg').innerText = `Matched: ${matchResult.bestMatch.name}!`;
                document.getElementById('biometricStatusMsg').style.color = "#10b981";
                const actionType = biometricMode.split('_')[1];
                setTimeout(async () => {
                    await handleKioskSuccess(matchResult.bestMatch.username, 'kiosk_' + actionType);
                }, 1000);
            } else {
                document.getElementById('biometricStatusMsg').innerText = "Face Not Recognized";
                document.getElementById('biometricStatusMsg').style.color = "#ef4444";
                alert(`Auto-recognition failed.\nNo matching face signature was found in the database.`);
            }
        }
    } catch (e) {
        console.error("Manual scan error:", e);
        hideSpinner();
        alert("Facial capture error occurred.");
    }
}

async function saveFaceDescriptorToCloud(username, descriptorArray) {
    showSpinner("Uploading facial template to secure cloud...");
    try {
        const res = await authFetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'registerFace',
                username: username,
                faceDescriptor: descriptorArray
            })
        }).then(r => r.json());

        if (res.success) {
            alert("Face biometric profile enrolled successfully!");
            cancelBiometricVerification();
            if (temporaryAuthSession) {
                await completeSessionAccess(temporaryAuthSession.user);
                temporaryAuthSession = null;
            } else {
                // Registration from Partner panel
                await syncDatabaseState();
                renderSystemDashboardEngine();
            }
        } else {
            alert("Failed to save biometric profile: " + res.message);
            cancelBiometricVerification();
        }
    } catch (err) {
        alert("Network error saving biometric template.");
        cancelBiometricVerification();
    } finally {
        hideSpinner();
    }
}

function cancelBiometricVerification() {
    if (detectionInterval) {
        clearInterval(detectionInterval);
        detectionInterval = null;
    }
    if (biometricStream) {
        biometricStream.getTracks().forEach(track => track.stop());
        biometricStream = null;
    }
    const video = document.getElementById('biometricVideo');
    if (video) video.srcObject = null;
    
    document.getElementById('biometricModal').classList.add('hidden');
    temporaryAuthSession = null;
    kioskTargetDescriptor = null;
}

function populateKioskOperatorDropdown() {
    const selectEl = document.getElementById('kioskOperatorSelect'); 
    if(!selectEl) return;
    selectEl.innerHTML = "";
    usersDB.forEach(u => { 
        if(u.role !== 'partner') { 
            let opt = document.createElement('option'); 
            opt.value = u.username; 
            opt.innerText = `${u.name} (${u.username}) [${u.role.toUpperCase()}]`; 
            selectEl.appendChild(opt); 
        } 
    });
    if (selectEl.innerHTML === "") {
        selectEl.innerHTML = `<option value="">No operators registered</option>`;
    }
}

function triggerKioskAttendanceAction(action) {
    const selectEl = document.getElementById('kioskOperatorSelect');
    if(!selectEl) return;
    const username = selectEl.value;
    if(!username) {
        alert("Please select a target operator first.");
        return;
    }
    
    const operator = usersDB.find(u => u.username === username);
    if(!operator) {
        alert("Selected operator not found.");
        return;
    }
    
    if(!operator.faceDescriptor) {
        alert(`The operator "${operator.name}" does not have a face profile enrolled. Please enroll their face in the Admin Control Center first.`);
        return;
    }
    
    startBiometricScan('kiosk_' + action, operator.username, operator.faceDescriptor);
}

async function triggerKioskODAction() {
    const selectEl = document.getElementById('kioskOperatorSelect');
    if(!selectEl) return;
    const username = selectEl.value;
    if(!username) {
        alert("Please select a target operator first.");
        return;
    }
    
    const operator = usersDB.find(u => u.username === username);
    if(!operator) {
        alert("Selected operator not found.");
        return;
    }

    if (!confirm(`Mark ${operator.name} as On-Duty (OD) for today?`)) return;

    showSpinner("Submitting attendance request...");
    try {
        const res = await authFetch('/api/attendance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'markOD',
                username: operator.username,
                name: operator.name,
                role: operator.role
            })
        }).then(r => r.json());
        
        if (res.success) {
            alert(`Attendance successfully logged for ${operator.name} (On Duty).`);
            await syncDatabaseState();
            renderSystemDashboardEngine();
        } else {
            alert("Error logging attendance: " + res.message);
        }
    } catch (err) {
        alert("Network error updating attendance records.");
    } finally {
        hideSpinner();
    }
}

async function handleKioskSuccess(username, mode) {
    const kioskAction = mode.split('_')[1]; // clockIn or clockOut
    const userObj = usersDB.find(u => u.username === username);
    if (!userObj) {
        alert("Target operator not found in local user database.");
        cancelBiometricVerification();
        return;
    }
    
    document.getElementById('biometricStatusMsg').innerText = `Identity Verified! Marking ${kioskAction === 'clockIn' ? 'Entry' : 'Exit'}...`;
    document.getElementById('biometricStatusMsg').style.color = "#10b981";
    
    showSpinner("Submitting attendance request...");
    try {
        const res = await authFetch('/api/attendance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: kioskAction,
                username: username,
                name: userObj.name,
                role: userObj.role
            })
        }).then(r => r.json());
        
        if (res.success) {
            alert(`Attendance successfully logged for ${userObj.name} (${kioskAction === 'clockIn' ? 'Clock-In/Entry' : 'Clock-Out/Exit'}).`);
            cancelBiometricVerification();
            await syncDatabaseState();
            renderSystemDashboardEngine();
        } else {
            alert("Error logging attendance: " + res.message);
            cancelBiometricVerification();
        }
    } catch (err) {
        alert("Network error updating attendance records.");
        cancelBiometricVerification();
    } finally {
        hideSpinner();
    }
}

async function toggleUserBiometric(username, isChecked) {
    showSpinner("Updating Biometric Settings...");
    try {
        const res = await authFetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'toggleBiometric',
                username,
                requireBiometric: isChecked
            })
        }).then(r => r.json());

        if (res.success) {
            await syncDatabaseState();
            renderPartnerAdminCenterViewports();
        } else {
            alert(res.message || "Failed to update configuration.");
        }
    } catch(e) {
        alert("Network error updating settings.");
    } finally {
        hideSpinner();
    }
}

async function resetUserFace(username) {
    if(!confirm(`Wipe biometric face print for user ${username}? They will need a new scan to verify.`)) return;
    showSpinner("Clearing Biometric Template...");
    try {
        const res = await authFetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'resetFace',
                username
            })
        }).then(r => r.json());

        if (res.success) {
            await syncDatabaseState();
            renderPartnerAdminCenterViewports();
        } else {
            alert(res.message || "Failed to reset face signature.");
        }
    } catch(e) {
        alert("Network error resetting template.");
    } finally {
        hideSpinner();
    }
}

function registerUserFace(username) {
    startBiometricScan('register', username);
}

// Render daily/monthly Attendance Sheet (Clock-In / Clock-Out) Logs with server-side filtering and pagination
async function renderPartnerAttendanceLogsViewport() {
    if(currentUserSession.role !== 'partner') return;

    const tbody = document.getElementById('masterAttendanceTableBody');
    if(!tbody) return;

    const viewModeEl = document.getElementById('attendanceViewMode');
    const dateInputEl = document.getElementById('attendanceFilterDate');
    const monthInputEl = document.getElementById('attendanceFilterMonth');
    
    const mode = viewModeEl ? viewModeEl.value : 'daily';
    const selectedDate = dateInputEl ? dateInputEl.value : new Date().toLocaleDateString('sv-SE');
    const selectedMonth = monthInputEl ? monthInputEl.value : new Date().toISOString().slice(0, 7);

    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:3rem; color:#94a3b8; font-style:italic;">Loading attendance logs...</td></tr>`;

    // Fetch targeted date or month data from server
    try {
        const queryParam = mode === 'daily' ? `date=${encodeURIComponent(selectedDate)}` : `month=${encodeURIComponent(selectedMonth)}`;
        const res = await authFetch(`/api/attendance?${queryParam}`).then(r => r.json());
        if (res.success) {
            attendanceLogs = res.logs || [];
        } else {
            attendanceLogs = [];
        }
    } catch (err) {
        console.error("Attendance fetch error:", err);
        attendanceLogs = [];
    }

    const thead = document.getElementById('masterAttendanceTableHead');

    if (mode === 'daily') {
        // Update table head headers
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th>No</th>
                    <th>Name</th>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Date</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Status</th>
                </tr>
            `;
        }

        // Filter logs for selected daily date
        const filteredLogs = attendanceLogs;

        // Paginate logs
        const totalLogs = filteredLogs.length;
        const pageSize = 25;
        const totalPages = Math.max(1, Math.ceil(totalLogs / pageSize));
        if (attendanceCurrentPage > totalPages) {
            attendanceCurrentPage = totalPages;
        }
        const startIndex = (attendanceCurrentPage - 1) * pageSize;
        const paginatedLogs = filteredLogs.slice(startIndex, startIndex + pageSize);

        tbody.innerHTML = "";

        paginatedLogs.forEach((log, index) => {
            const tr = document.createElement('tr');
            const relativeIndex = index + startIndex + 1;
            
            const formatTime = (ts) => {
                if (log.status === 'Absent' || log.status === 'On Duty') {
                    return `<span style="color:#94a3b8;">-</span>`;
                }
                if (!ts) return `<span style="color:#94a3b8; font-style:italic;">Active Shift</span>`;
                const date = new Date(ts);
                return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
            };

            let statusColor = 'var(--success-color)';
            if (log.status === 'Active') {
                statusColor = 'var(--warning-color)';
            } else if (log.status === 'Absent') {
                statusColor = 'var(--danger-color)';
            } else if (log.status === 'On Duty') {
                statusColor = 'var(--accent-color)';
            }
            const statusBadge = `<span class="status" style="background-color:rgba(0,0,0,0.05); color:${statusColor}; border:1px solid ${statusColor}; font-weight:700;">${log.status}</span>`;

            tr.innerHTML = `
                <td data-label="No">${relativeIndex}</td>
                <td data-label="Name" style="font-weight:600; color:var(--primary-color);">${log.name}</td>
                <td data-label="Username" style="font-family:monospace;">${log.username}</td>
                <td data-label="Role" style="text-transform: capitalize;">${log.role}</td>
                <td data-label="Date">${standardDateFormatter(log.date)}</td>
                <td data-label="In" style="font-weight:500; color:var(--secondary-color);">${formatTime(log.clockIn)}</td>
                <td data-label="Out" style="font-weight:500;">${formatTime(log.clockOut)}</td>
                <td data-label="Status">${statusBadge}</td>
            `;
            tbody.appendChild(tr);
        });

        if(filteredLogs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:4rem; color:#94a3b8; font-style:italic;">No attendance sessions logged for this period.</td></tr>`;
        }

        const paginationContainer = document.getElementById('attendancePaginationContainer');
        if (paginationContainer) {
            paginationContainer.innerHTML = `
                <div style="color: #475569; font-weight: 500; font-size: 0.9rem;">Showing ${totalLogs === 0 ? 0 : startIndex + 1} to ${Math.min(startIndex + pageSize, totalLogs)} of ${totalLogs} logs</div>
                <div style="display:flex; gap:0.5rem; align-items: center;">
                    <button class="action-btn btn-secondary" ${attendanceCurrentPage === 1 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeAttendancePage(${attendanceCurrentPage - 1})">Prev</button>
                    <span style="font-weight:600; padding:0 0.5rem; color: var(--primary-color); font-size: 0.9rem;">Page ${attendanceCurrentPage} of ${totalPages}</span>
                    <button class="action-btn btn-secondary" ${attendanceCurrentPage === totalPages ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeAttendancePage(${attendanceCurrentPage + 1})">Next</button>
                </div>
            `;
        }
    } else {
        // Update table head headers to Monthly View layout
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th>No</th>
                    <th>Name</th>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Month</th>
                    <th>Present Days</th>
                    <th>Absent Days</th>
                    <th>On Duty (OD) Days</th>
                </tr>
            `;
        }

        // Non-partner users list to calculate monthly summary for
        const nonPartners = usersDB.filter(u => u.role !== 'partner');

        const formatMonth = (ym) => {
            if (!ym) return '-';
            const [y, m] = ym.split('-');
            const date = new Date(y, parseInt(m) - 1, 1);
            return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
        };

        // Aggregations
        const monthlySummaries = nonPartners.map(user => {
            let present = 0;
            let absent = 0;
            let od = 0;
            attendanceLogs.forEach(log => {
                if (log.username.toLowerCase() === user.username.toLowerCase() && log.date && log.date.startsWith(selectedMonth)) {
                    if (log.status === 'Completed' || log.status === 'Active' || log.status === 'Present') {
                        present++;
                    } else if (log.status === 'Absent') {
                        absent++;
                    } else if (log.status === 'On Duty') {
                        od++;
                    }
                }
            });
            return {
                name: user.name,
                username: user.username,
                role: user.role,
                month: selectedMonth,
                present,
                absent,
                od
            };
        });

        // Paginate staff summaries
        const totalItems = monthlySummaries.length;
        const pageSize = 25;
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
        if (attendanceCurrentPage > totalPages) {
            attendanceCurrentPage = totalPages;
        }
        const startIndex = (attendanceCurrentPage - 1) * pageSize;
        const paginatedItems = monthlySummaries.slice(startIndex, startIndex + pageSize);

        tbody.innerHTML = "";

        paginatedItems.forEach((item, index) => {
            const tr = document.createElement('tr');
            const relativeIndex = index + startIndex + 1;
            
            tr.innerHTML = `
                <td data-label="No">${relativeIndex}</td>
                <td data-label="Name" style="font-weight:600; color:var(--primary-color);">${item.name}</td>
                <td data-label="Username" style="font-family:monospace;">${item.username}</td>
                <td data-label="Role" style="text-transform: capitalize;">${item.role}</td>
                <td data-label="Month">${formatMonth(item.month)}</td>
                <td data-label="Present Days" style="font-weight:600; color:var(--success-color);">${item.present}</td>
                <td data-label="Absent Days" style="font-weight:600; color:var(--danger-color);">${item.absent}</td>
                <td data-label="On Duty (OD) Days" style="font-weight:600; color:var(--accent-color);">${item.od}</td>
            `;
            tbody.appendChild(tr);
        });

        if(monthlySummaries.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:4rem; color:#94a3b8; font-style:italic;">No staff records found.</td></tr>`;
        }

        const paginationContainer = document.getElementById('attendancePaginationContainer');
        if (paginationContainer) {
            paginationContainer.innerHTML = `
                <div style="color: #475569; font-weight: 500; font-size: 0.9rem;">Showing ${totalItems === 0 ? 0 : startIndex + 1} to ${Math.min(startIndex + pageSize, totalItems)} of ${totalItems} staff</div>
                <div style="display:flex; gap:0.5rem; align-items: center;">
                    <button class="action-btn btn-secondary" ${attendanceCurrentPage === 1 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeAttendancePage(${attendanceCurrentPage - 1})">Prev</button>
                    <span style="font-weight:600; padding:0 0.5rem; color: var(--primary-color); font-size: 0.9rem;">Page ${attendanceCurrentPage} of ${totalPages}</span>
                    <button class="action-btn btn-secondary" ${attendanceCurrentPage === totalPages ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="changeAttendancePage(${attendanceCurrentPage + 1})">Next</button>
                </div>
            `;
        }
    }
}

// Export Attendance Sheet CSV Matrix (Filtered only)
async function exportAttendanceLogsCSV() {
    const viewModeEl = document.getElementById('attendanceViewMode');
    const dateInputEl = document.getElementById('attendanceFilterDate');
    const monthInputEl = document.getElementById('attendanceFilterMonth');
    
    const mode = viewModeEl ? viewModeEl.value : 'daily';
    const selectedDate = dateInputEl ? dateInputEl.value : new Date().toLocaleDateString('sv-SE');
    const selectedMonth = monthInputEl ? monthInputEl.value : new Date().toISOString().slice(0, 7);

    // Fetch targeted date or month data from server
    let exportLogs = [];
    try {
        const queryParam = mode === 'daily' ? `date=${encodeURIComponent(selectedDate)}` : `month=${encodeURIComponent(selectedMonth)}`;
        const res = await authFetch(`/api/attendance?${queryParam}`).then(r => r.json());
        if (res.success) {
            exportLogs = res.logs || [];
        }
    } catch (err) {
        exportLogs = attendanceLogs || [];
    }

    let rows = [];
    
    if (mode === 'daily') {
        rows.push(["Sl No", "Operator Name", "Username", "Security Role", "Date", "Clock-In Entry Time", "Clock-Out Exit Time", "Shift Status"]);
        exportLogs.forEach((log, idx) => {
            const clockInFormatted = log.clockIn ? new Date(log.clockIn).toISOString() : '-';
            const clockOutFormatted = log.clockOut ? new Date(log.clockOut).toISOString() : 'Active';
            rows.push([
                (idx + 1),
                log.name,
                log.username,
                log.role,
                log.date,
                clockInFormatted,
                clockOutFormatted,
                log.status
            ]);
        });
    } else {
        rows.push(["Sl No", "Operator Name", "Username", "Security Role", "Month", "Present Days", "Absent Days", "On Duty (OD) Days"]);
        const nonPartners = usersDB.filter(u => u.role !== 'partner');
        nonPartners.forEach((user, idx) => {
            let present = 0;
            let absent = 0;
            let od = 0;
            exportLogs.forEach(log => {
                if (log.username.toLowerCase() === user.username.toLowerCase() && log.date && log.date.startsWith(selectedMonth)) {
                    if (log.status === 'Completed' || log.status === 'Active' || log.status === 'Present') {
                        present++;
                    } else if (log.status === 'Absent') {
                        absent++;
                    } else if (log.status === 'On Duty') {
                        od++;
                    }
                }
            });
            rows.push([
                (idx + 1),
                user.name,
                user.username,
                user.role,
                selectedMonth,
                present,
                absent,
                od
            ]);
        });
    }

    let csvContent = "data:text/csv;charset=utf-8,\u200B" + rows.map(r => r.map(f => `"${String(f).replace(/"/g, '""')}"`).join(",")).join("\n");
    let encodedUri = encodeURI(csvContent);
    let link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    
    const filenameSuffix = mode === 'daily' ? selectedDate : selectedMonth;
    link.setAttribute("download", `SMK_Attendance_Logs_${filenameSuffix}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function triggerAutoKioskAttendanceAction(action) {
    startBiometricScan('auto_' + action, 'Auto-Scanner', null);
}
