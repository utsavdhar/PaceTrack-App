import React, { useState, useEffect, memo } from 'react';
import { auth, db } from './firebase';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';

// --- HELPER: Calculation Logic ---
const calculatePaceMetrics = (type, goalVal, yearsCount) => {
  const totalGoal = parseFloat(goalVal) || 0;
  if (totalGoal <= 0) return { divisorLabel: 'period', microTarget: 0 };

  switch(type) {
    case 'expense-control': return { divisorLabel: 'month pool', microTarget: totalGoal };
    case 'weekly': return { divisorLabel: 'week', microTarget: totalGoal };
    case 'monthly': return { divisorLabel: 'month', microTarget: totalGoal };
    case 'yearly': return { divisorLabel: 'month', microTarget: parseFloat((totalGoal / 12).toFixed(0)) };
    case 'multi-year':
      const totalMonths = (parseInt(yearsCount) || 2) * 12;
      return { divisorLabel: 'month', microTarget: parseFloat((totalGoal / totalMonths).toFixed(0)) };
    default: return { divisorLabel: 'period', microTarget: totalGoal };
  }
};

const recalculateTrackerBalances = (tracker) => {
  const isExpenseMode = tracker.type === 'expense-control';
  const baseBalance = isExpenseMode ? tracker.totalGoal : 0;
  
  let currentBalance = baseBalance;
  let currentMilestone = baseBalance;

  const sortedTx = [...tracker.transactions].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  
  sortedTx.forEach((tx) => {
    let balanceChange = 0;
    if (isExpenseMode) {
      if (tx.type === 'settlement') {
        currentBalance = tracker.totalGoal;
        currentMilestone = tracker.totalGoal;
        return;
      }
      balanceChange = tx.type === 'expense' ? -tx.amount : tx.amount;
    } else {
      if (tx.type === 'settlement') {
        currentBalance = 0;
        currentMilestone = 0;
        return;
      }
      balanceChange = tx.type === 'deposit' ? tx.amount : -tx.amount;
    }
    
    currentBalance += balanceChange;
    if (isExpenseMode) {
      currentMilestone = currentBalance;
    } else {
      currentMilestone = Math.max(0, currentMilestone + balanceChange);
    }
  });

  return { ...tracker, savingsBalance: currentBalance, currentMilestoneSaved: currentMilestone };
};

// --- COMPONENT: Universal Currency Input Accessory ---
const CurrencyInputWrapper = ({ children, theme }) => (
  <div className="relative flex items-center w-full group">
    {children}
    <div className={`absolute right-3.5 text-[10px] font-bold tracking-wider select-none px-1.5 py-0.5 rounded transition-colors ${
      theme === 'dark' ? 'bg-zinc-800 text-zinc-400 group-focus-within:text-emerald-400' : 'bg-zinc-200/60 text-zinc-500 group-focus-within:text-emerald-600'
    }`}>
      BDT
    </div>
  </div>
);

// --- COMPONENT: UI Toast Notification ---
const ToastNotification = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [message, onClose]);

  return (
    <div className={`fixed bottom-5 right-5 z-50 flex items-center gap-3 px-4 py-3.5 rounded-xl shadow-2xl border backdrop-blur-md animate-slideIn transition-all max-w-sm ${
      type === 'error' 
        ? 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400 shadow-rose-950/10' 
        : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 shadow-emerald-950/10'
    }`}>
      <span className={`h-2 w-2 rounded-full shrink-0 ${type === 'error' ? 'bg-rose-500' : 'bg-emerald-500'}`} />
      <p className="text-xs font-semibold leading-relaxed tracking-wide">{message}</p>
      <button onClick={onClose} className="text-[10px] uppercase font-bold tracking-widest opacity-60 hover:opacity-100 ml-2">Dismiss</button>
    </div>
  );
};

// --- COMPONENT: Modern Confirmation Modal Dialog ---
const ConfirmationModal = ({ isOpen, title, description, confirmLabel, cancelLabel, onConfirm, onCancel, theme }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fadeIn">
      <div className={`w-full max-w-xs border rounded-2xl p-5 space-y-4 shadow-2xl transition-all ${
        theme === 'dark' ? 'bg-zinc-900 border-zinc-800 shadow-black/50' : 'bg-white border-zinc-200 shadow-zinc-300/50'
      }`}>
        <div className="space-y-1.5">
          <h3 className={`text-sm font-bold tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{title}</h3>
          <p className={`text-xs leading-relaxed ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-500'}`}>{description}</p>
        </div>
        <div className="flex justify-end gap-2 text-[11px] font-bold uppercase tracking-wider pt-1">
          <button onClick={onCancel} className={`px-3.5 py-2 rounded-lg transition-colors ${theme === 'dark' ? 'text-zinc-400 hover:bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-100'}`}>
            {cancelLabel || 'Cancel'}
          </button>
          <button onClick={onConfirm} className="px-3.5 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-500 shadow-md active:scale-95 transition-all">
            {confirmLabel || 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

// --- COMPONENT: Tracker Setup Form ---
const TrackerSetupForm = memo(({ theme, onCreateTracker }) => {
  const [trackerName, setTrackerName] = useState('');
  const [timelineType, setTimelineType] = useState('monthly'); 
  const [customYears, setCustomYears] = useState('2'); 
  const [startPeriod, setStartPeriod] = useState(() => new Date().toISOString().split('T')[0]);
  const [targetAmount, setTargetAmount] = useState('');
  const [incomeBase, setIncomeBase] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!trackerName || !targetAmount) return;
    
    onCreateTracker({ trackerName, timelineType, customYears, startPeriod, targetAmount, incomeBase });
    
    setTrackerName('');
    setTargetAmount('');
    setIncomeBase('');
  };

  const currentPreview = calculatePaceMetrics(timelineType, targetAmount, customYears);
  const incomeNum = parseFloat(incomeBase) || 0;
  const incomePercentage = incomeNum > 0 ? ((currentPreview.microTarget / incomeNum) * 100).toFixed(1) : 0;

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className={`border p-5 rounded-2xl shadow-xl space-y-4 transition-all duration-300 hover:shadow-2xl ${
        theme === 'dark' ? 'bg-zinc-900/40 border-zinc-900 hover:border-zinc-800' : 'bg-white border-zinc-200 shadow-zinc-200/60 hover:border-zinc-300'
      }`}>
        <h2 className={`text-[10px] font-bold tracking-widest uppercase ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-500'}`}>Set Up Tracker</h2>
        
        <div className="space-y-4">
          <input
            type="text"
            placeholder="Goal Name (e.g., Household Savings)"
            value={trackerName}
            onChange={(e) => setTrackerName(e.target.value)}
            className={`w-full border rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all font-medium ${
              theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white placeholder:text-zinc-600' : 'bg-zinc-50 border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
            }`}
            required
          />

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest mb-1.5 px-0.5 text-zinc-500">Tracking Schedule</label>
            <div className={`grid grid-cols-3 gap-1 p-1 rounded-xl border ${theme === 'dark' ? 'bg-zinc-900/80 border-zinc-800/60' : 'bg-zinc-100 border-zinc-300'}`}>
              {['weekly', 'monthly', 'yearly', 'multi-year', 'expense-control'].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTimelineType(mode)}
                  className={`py-2 text-[10px] sm:text-xs font-bold rounded-lg transition-all text-center duration-300 capitalize ${
                    timelineType === mode 
                      ? (theme === 'dark' ? 'bg-zinc-800 text-white shadow-sm font-black scale-[0.98]' : 'bg-white text-zinc-950 shadow-sm font-black scale-[0.98]') 
                      : (theme === 'dark' ? 'text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50' : 'text-zinc-600 hover:text-zinc-900 hover:bg-white/50')
                  }`}
                >
                  {mode === 'expense-control' ? 'Expense' : mode.replace('-', ' ')}
                </button>
              ))}
            </div>
          </div>

          {timelineType === 'multi-year' && (
            <div className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2 animate-fadeIn ${theme === 'dark' ? 'bg-black/10 border-zinc-800' : 'bg-zinc-100 border-zinc-200'}`}>
              <div>
                <label className={`block text-[10px] font-bold uppercase tracking-widest ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Time Scale</label>
                <span className={`text-xs font-medium ${theme === 'dark' ? 'text-zinc-500' : 'text-zinc-600'}`}>Set duration up to 10 years.</span>
              </div>
              <div className="flex items-center gap-2 self-end sm:self-auto">
                <input 
                  type="range" min="2" max="10" 
                  value={customYears} 
                  onChange={(e) => setCustomYears(e.target.value)}
                  className="accent-emerald-500 w-24 cursor-pointer"
                />
                <span className={`text-xs font-semibold px-2 py-0.5 rounded ${theme === 'dark' ? 'bg-zinc-800 text-white' : 'bg-zinc-200 text-zinc-900'}`}>{customYears} Yrs</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest mb-1 px-0.5 text-zinc-500">Start Date</label>
              <input
                type="date"
                value={startPeriod}
                onChange={(e) => setStartPeriod(e.target.value)}
                className={`w-full border rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${
                  theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white' : 'bg-zinc-50 border-zinc-300 text-zinc-900'
                }`}
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest mb-1 px-0.5 text-zinc-500">
                {timelineType === 'expense-control' ? 'Monthly Budget' : 'Savings Target'}
              </label>
              <CurrencyInputWrapper theme={theme}>
                <input
                  type="number"
                  placeholder="0.00"
                  value={targetAmount}
                  onChange={(e) => setTargetAmount(e.target.value)}
                  className={`w-full border rounded-xl pl-3.5 pr-14 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${
                    theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white placeholder:text-zinc-700' : 'bg-zinc-50 border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
                  }`}
                  required
                />
              </CurrencyInputWrapper>
            </div>
          </div>

          {timelineType !== 'expense-control' && (
            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-widest px-0.5 text-zinc-500">Monthly Salary (Optional)</label>
              <CurrencyInputWrapper theme={theme}>
                <input
                  type="number"
                  placeholder="0.00"
                  value={incomeBase}
                  onChange={(e) => setIncomeBase(e.target.value)}
                  className={`w-full border rounded-xl pl-3.5 pr-14 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all ${
                    theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white placeholder:text-zinc-700' : 'bg-zinc-50 border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
                  }`}
                />
              </CurrencyInputWrapper>
            </div>
          )}

          <button
            type="submit"
            className={`w-full font-bold py-3 rounded-xl text-xs transition-all tracking-wider uppercase active:scale-[0.98] hover:-translate-y-0.5 shadow-md hover:shadow-lg ${
              theme === 'dark' ? 'bg-white hover:bg-zinc-200 text-black' : 'bg-zinc-950 hover:bg-zinc-800 text-white'
            }`}
          >
            Create Budget Plan
          </button>
        </div>
      </form>

      {targetAmount > 0 && timelineType !== 'expense-control' && (
        <div className={`border p-4 rounded-xl flex justify-between items-center animate-fadeIn shadow-sm ${
          theme === 'dark' ? 'bg-zinc-900/20 border-dashed border-zinc-800/80' : 'bg-zinc-100/50 border-dashed border-zinc-300'
        }`}>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Required Breakdown Goal</div>
            <div className={`text-lg font-bold tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>
              {parseInt(currentPreview.microTarget).toLocaleString()}
              <span className="text-xs font-semibold text-zinc-400 ml-1">BDT</span>
              <span className="text-xs font-normal text-zinc-500"> / {currentPreview.divisorLabel}</span>
            </div>
          </div>
          {incomeNum > 0 && (
            <div className="text-right">
              <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Budget Strain</div>
              <div className="text-sm font-bold text-emerald-500">{incomePercentage}%</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// --- MAIN APP COMPONENT ---
function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem('pt-theme') || 'dark');
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => localStorage.getItem('pt-remember') === 'true');
  const [isRegistering, setIsRegistering] = useState(false);
  const [trackers, setTrackers] = useState([]);

  // Toast System State
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  
  // Custom Confirmation Dialog State
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, title: '', description: '', action: null });

  const triggerToast = (message, type = 'success') => {
    setToast({ show: true, message, type });
  };

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 1600); 
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => localStorage.setItem('pt-theme', theme), [theme]);
  useEffect(() => localStorage.setItem('pt-remember', rememberMe ? 'true' : 'false'), [rememberMe]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
      if (currentUser === null && localStorage.getItem('pt-remember') === 'true') {
        const savedEmail = localStorage.getItem('pt-saved-email');
        if (savedEmail) setEmail(savedEmail);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) { setTrackers([]); return; }
    const userDocRef = doc(db, "users", user.uid);
    const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
      if (docSnap.exists() && docSnap.data().trackers) {
        setTrackers(docSnap.data().trackers);
      } else {
        setTrackers([]);
      }
    });
    return unsubscribe;
  }, [user]);

  const handleAuth = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    try {
      if (isRegistering) { 
        await createUserWithEmailAndPassword(auth, email, password); 
        triggerToast("Account registered successfully!");
      } else { 
        await signInWithEmailAndPassword(auth, email, password); 
        triggerToast("Signed in securely.");
      }
      
      if (rememberMe) localStorage.setItem('pt-saved-email', email);
      else localStorage.removeItem('pt-saved-email');
      setShowPassword(false);
    } catch (error) { 
      triggerToast(error.message, "error");
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      if (!rememberMe) setEmail('');
      setPassword(''); 
      triggerToast("Logged out successfully.");
    } catch (error) { 
      triggerToast("Sign out failure.", "error"); 
    }
  };

  const saveTrackersToCloud = async (updatedList) => {
    if (!user) return;
    try { await setDoc(doc(db, "users", user.uid), { trackers: updatedList }, { merge: true }); } 
    catch (error) { triggerToast("Cloud synchronization failure.", "error"); }
  };

  const exportToCSV = () => {
    if (trackers.length === 0) return triggerToast("No tracking data available to export.", "error");
    let csv = "Tracker Name,Type,Date,Action,Amount,Currency,Note\n";
    
    trackers.forEach(t => {
      const sortedTx = [...(t.transactions || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      sortedTx.forEach(tx => {
        const dateStr = new Date(tx.timestamp || Date.now()).toLocaleDateString('en-BD');
        csv += `"${t.name}","${t.type}","${dateStr}","${tx.type}",${tx.amount},"BDT","${tx.reason || ''}"\n`;
      });
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `PaceTrack_Backup_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    triggerToast("Data backup file generated.");
  };

  const handleCreateTracker = (trackerData) => {
    const goalVal = parseFloat(trackerData.targetAmount);
    const { divisorLabel, microTarget } = calculatePaceMetrics(trackerData.timelineType, goalVal, trackerData.customYears);
    const startingBalance = trackerData.timelineType === 'expense-control' ? goalVal : 0;

    const newTracker = {
      id: Date.now().toString(),
      name: trackerData.trackerName,
      type: trackerData.timelineType,
      yearsScale: trackerData.timelineType === 'multi-year' ? parseInt(trackerData.customYears) : 1,
      startPeriod: trackerData.startPeriod,
      totalGoal: goalVal,
      incomeBase: parseFloat(trackerData.incomeBase) || 0,
      microTarget: microTarget,
      targetPeriodLabel: divisorLabel,
      savingsBalance: startingBalance, 
      currentMilestoneSaved: startingBalance, 
      transactions: []   
    };

    const updated = [...trackers, newTracker];
    setTrackers(updated);
    saveTrackersToCloud(updated);
    triggerToast(`Tracker Plan "${trackerData.trackerName}" deployed.`);
  };

  const handleLogTransaction = (trackerId, type, amountValue, reasonText) => {
    const numAmount = parseFloat(amountValue);
    if (isNaN(numAmount) || numAmount <= 0) return triggerToast("Please enter a valid amount.", "error");

    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const newTx = {
          id: Date.now().toString(),
          timestamp: Date.now(),
          type: type,
          amount: numAmount,
          reason: reasonText || (type === 'deposit' ? 'Added Funds' : 'Logged Expense')
        };
        const updatedTrack = { ...track, transactions: [newTx, ...(track.transactions || [])] };
        return recalculateTrackerBalances(updatedTrack);
      }
      return track;
    });

    setTrackers(updated);
    saveTrackersToCloud(updated);
    triggerToast("Transaction entry posted.");
  };

  const handleEditTransaction = (trackerId, transactionId, newAmount, newReason) => {
    const numAmount = parseFloat(newAmount);
    if (isNaN(numAmount) || numAmount <= 0) return triggerToast("Please enter a valid amount.", "error");

    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const updatedTxList = track.transactions.map((tx) => 
          tx.id === transactionId ? { ...tx, amount: numAmount, reason: newReason } : tx
        );
        return recalculateTrackerBalances({ ...track, transactions: updatedTxList });
      }
      return track;
    });

    setTrackers(updated);
    saveTrackersToCloud(updated);
    triggerToast("Transaction entry amended.");
  };

  // Safe UI Confirmation wrapping for entry logs
  const handleDeleteTransactionPrompt = (trackerId, transactionId) => {
    setConfirmModal({
      isOpen: true,
      title: "Remove Transaction Entry",
      description: "Are you sure you want to permanently erase this ledger record? This action cannot be reversed.",
      confirmLabel: "Remove Entry",
      action: () => {
        const updated = trackers.map((track) => {
          if (track.id === trackerId) {
            const updatedTxList = track.transactions.filter((tx) => tx.id !== transactionId);
            return recalculateTrackerBalances({ ...track, transactions: updatedTxList });
          }
          return track;
        });
        setTrackers(updated);
        saveTrackersToCloud(updated);
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        triggerToast("Transaction record purged.");
      }
    });
  };

  // Safe UI Confirmation wrapping for budget channels
  const handleDeleteTrackerPrompt = (trackerId) => {
    setConfirmModal({
      isOpen: true,
      title: "Terminate Active Tracker",
      description: "Are you completely sure you want to drop this entire budget channel? All historical entry records linked here will be permanently cleared.",
      confirmLabel: "Terminate Plan",
      action: () => {
        const updated = trackers.filter((t) => t.id !== trackerId);
        setTrackers(updated);
        saveTrackersToCloud(updated);
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        triggerToast("Budget configuration destroyed.");
      }
    });
  };

  const handleSettleMilestone = (trackerId) => {
    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const isExpenseMode = track.type === 'expense-control';
        const updatedTrack = {
          ...track,
          transactions: [{
            id: Date.now().toString(),
            timestamp: Date.now(),
            type: 'settlement',
            amount: isExpenseMode ? track.savingsBalance : (track.microTarget || 0),
            reason: isExpenseMode ? `Renewed Balance` : `Completed Milestone`,
          }, ...(track.transactions || [])]
        };
        return recalculateTrackerBalances(updatedTrack);
      }
      return track;
    });
    setTrackers(updated);
    saveTrackersToCloud(updated);
    triggerToast("Cycle timeline resolved.");
  };

  if (showSplash) {
    return (
      <div className="fixed inset-0 bg-zinc-950 flex flex-col items-center justify-center z-50 transition-opacity duration-500 ease-out animate-fadeIn">
        <div className="relative flex flex-col items-center space-y-4">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 p-0.5 flex items-center justify-center shadow-[0_0_30px_rgba(16,185,129,0.25)]">
            <div className="h-full w-full bg-zinc-900 rounded-[10px] flex items-center justify-center">
              <span className="text-white font-sans text-sm font-black tracking-tighter">PT</span>
            </div>
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white font-sans">PaceTrack</h1>
        </div>
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${theme === 'dark' ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
        <div className="h-5 w-5 rounded-full border-2 border-zinc-300/30 border-t-emerald-500 animate-spin"></div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen transition-colors duration-500 antialiased flex flex-col items-center pt-[env(safe-area-inset-top,24px)] pb-10 px-4 sm:px-6 w-full ${
      theme === 'dark' ? 'bg-zinc-950 text-zinc-100 selection:bg-emerald-500/20' : 'bg-zinc-50 text-zinc-900 selection:bg-emerald-500/10'
    }`}>
      
      {toast.show && (
        <ToastNotification 
          message={toast.message} 
          type={toast.type} 
          onClose={() => setToast(prev => ({ ...prev, show: false }))} 
        />
      )}

      <ConfirmationModal 
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        description={confirmModal.description}
        confirmLabel={confirmModal.confirmLabel}
        onConfirm={confirmModal.action}
        onCancel={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        theme={theme}
      />

      {!user ? (
        <div className="w-full max-w-sm my-auto space-y-6 animate-fadeIn">
          <div className="text-center space-y-1">
            <h1 className={`text-3xl font-black tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>PaceTrack</h1>
            <p className="text-xs font-semibold text-zinc-500">Track your finances cleanly</p>
          </div>

          <form onSubmit={handleAuth} className={`border p-6 rounded-2xl shadow-2xl space-y-5 backdrop-blur-md transition-all duration-300 hover:shadow-[0_0_30px_rgba(0,0,0,0.1)] ${
            theme === 'dark' ? 'bg-zinc-900/40 border-zinc-800' : 'bg-white border-zinc-200'
          }`}>
            <h2 className={`text-[10px] font-bold tracking-widest uppercase ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-500'}`}>
              {isRegistering ? 'Create Account' : 'Welcome Back'}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider mb-1 px-0.5 text-zinc-500">Email Address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`w-full border rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all font-medium ${
                    theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white placeholder:text-zinc-600' : 'bg-zinc-100/80 border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
                  }`}
                  required
                />
              </div>
              
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider mb-1 px-0.5 text-zinc-500">Password</label>
                <div className="relative w-full">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`w-full border rounded-xl pl-3.5 pr-11 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all font-medium ${
                      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white placeholder:text-zinc-600' : 'bg-zinc-100/80 border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
                    }`}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className={`absolute right-3 top-1/2 -translate-y-1/2 px-2 py-1 text-[10px] uppercase font-bold tracking-wider rounded-lg hover:bg-zinc-500/10 transition-colors ${theme === 'dark' ? 'text-zinc-500' : 'text-zinc-400'}`}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between pt-0.5 px-0.5">
                <label className="flex items-center space-x-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded border-zinc-300 text-emerald-500 focus:ring-emerald-500 cursor-pointer transition-all"
                  />
                  <span className="text-[11px] font-semibold select-none transition-colors group-hover:text-emerald-500 text-zinc-500">Remember me</span>
                </label>
              </div>
            </div>

            <button
              type="submit"
              className={`w-full font-bold py-3 rounded-xl text-xs transition-all tracking-wider uppercase active:scale-[0.98] hover:-translate-y-0.5 shadow-md ${
                theme === 'dark' ? 'bg-white hover:bg-zinc-200 text-black' : 'bg-zinc-950 hover:bg-zinc-800 text-white'
              }`}
            >
              {isRegistering ? 'Register Account' : 'Sign In To Dashboard'}
            </button>

            <div className="text-center pt-1">
              <button
                type="button"
                onClick={() => { setIsRegistering(!isRegistering); setShowPassword(false); }}
                className={`text-xs transition-colors font-semibold underline underline-offset-4 ${theme === 'dark' ? 'text-zinc-400 hover:text-white' : 'text-zinc-600 hover:text-zinc-950'}`}
              >
                {isRegistering ? 'Have an account? Log in' : "Don't have an account? Sign up"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="w-full max-w-md space-y-6 animate-fadeIn">
          <header className={`w-full flex justify-between items-center py-5 border-b transition-all ${theme === 'dark' ? 'border-zinc-900' : 'border-zinc-200'}`}>
            <div>
              <h1 className={`text-2xl font-black tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>PaceTrack</h1>
              <span className="text-xs flex items-center gap-1.5 mt-1 font-medium text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]"></span>
                {user.email}
              </span>
            </div>
            
            <div className="flex items-center gap-1.5">
              <button onClick={exportToCSV} title="Export to CSV" className={`px-2.5 py-1.5 rounded-xl border text-[11px] font-bold transition-all active:scale-95 ${theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800 text-zinc-300 hover:text-white' : 'bg-white border-zinc-300 text-zinc-700 hover:text-zinc-950'}`}>
                CSV
              </button>
              <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className={`px-2.5 py-1.5 rounded-xl border text-[11px] font-bold transition-all active:scale-95 ${theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800 text-zinc-300 hover:text-white' : 'bg-white border-zinc-300 text-zinc-700 hover:text-zinc-950'}`}>
                {theme === 'dark' ? 'Light' : 'Dark'}
              </button>
              <button onClick={handleSignOut} className={`text-[10px] uppercase font-bold tracking-widest border px-2.5 py-1.5 rounded-xl transition-all active:scale-95 ${theme === 'dark' ? 'bg-zinc-900/20 border-zinc-800 text-zinc-400 hover:text-rose-400 hover:border-rose-950' : 'bg-white border-zinc-300 text-zinc-600 hover:text-rose-600 hover:border-rose-300'}`}>
                Exit
              </button>
            </div>
          </header>

          <TrackerSetupForm theme={theme} onCreateTracker={handleCreateTracker} />

          <div className="space-y-4">
            <div className="flex justify-between items-center px-0.5">
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Active Budgets</h2>
              <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Trackers: {trackers.length}</span>
            </div>
            
            {trackers.length === 0 ? (
              <div className={`text-center py-10 border border-dashed rounded-2xl transition-all ${theme === 'dark' ? 'bg-zinc-900/10 border-zinc-800' : 'bg-zinc-100/20 border-zinc-300'}`}>
                <p className="text-xs tracking-wide px-4 text-zinc-500">No active tracking schedules. Create your first one above!</p>
              </div>
            ) : (
              <div className="space-y-4">
                {trackers.map((item) => (
                  <ActiveTrackerCard 
                    key={item.id} 
                    tracker={item} 
                    theme={theme}
                    onLog={handleLogTransaction} 
                    onEditTx={handleEditTransaction}
                    onDeleteTx={handleDeleteTransactionPrompt}
                    onDeleteTracker={handleDeleteTrackerPrompt}
                    onSettle={handleSettleMilestone}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- COMPONENT: Active Tracker Card ---
const ActiveTrackerCard = memo(({ tracker, theme, onLog, onEditTx, onDeleteTx, onDeleteTracker, onSettle }) => {
  const [logAmount, setLogAmount] = useState('');
  const [logReason, setLogReason] = useState('');
  
  const [editingTxId, setEditingTxId] = useState(null);
  const [editAmount, setEditAmount] = useState('');
  const [editReason, setEditReason] = useState('');

  const isExpenseMode = tracker.type === 'expense-control';
  const totalGoal = tracker.totalGoal || 0;
  const savingsBalance = tracker.savingsBalance !== undefined ? tracker.savingsBalance : 0;
  const microTarget = tracker.microTarget || 0;
  const targetPeriodLabel = tracker.targetPeriodLabel || 'month';
  const transactions = [...(tracker.transactions || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const submitLog = (type) => {
    if (!logAmount) return;
    onLog(tracker.id, type, logAmount, logReason);
    setLogAmount('');
    setLogReason('');
  };

  const startEditing = (tx) => {
    setEditingTxId(tx.id);
    setEditAmount(tx.amount.toString());
    setEditReason(tx.reason);
  };

  const saveEdit = (txId) => {
    onEditTx(tracker.id, txId, editAmount, editReason);
    setEditingTxId(null);
  };

  const budgetRemainingPercent = totalGoal > 0 ? Math.max(0, ((savingsBalance / totalGoal) * 100)) : 0;
  const velocityGoalPercent = totalGoal > 0 ? Math.max(0, ((savingsBalance / totalGoal) * 100)) : 0;
  const currentMilestonePercent = microTarget > 0 ? Math.max(0, ((tracker.currentMilestoneSaved / microTarget) * 100)) : 0;

  return (
    <div className={`border p-5 rounded-2xl shadow-xl space-y-4 backdrop-blur-md transition-all duration-500 relative group hover:-translate-y-0.5 hover:shadow-2xl ${
      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 hover:border-zinc-700 shadow-black/40' : 'bg-white border-zinc-300 hover:border-zinc-400 shadow-zinc-200/40'
    }`}>
      
      <button 
        onClick={() => onDeleteTracker(tracker.id)}
        className="absolute top-4 right-4 text-zinc-400 hover:text-rose-500 transition-colors text-[10px] font-bold uppercase tracking-wider p-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        title="Remove Track Schedule"
      >
        Delete
      </button>

      <div className="flex justify-between items-start pr-12">
        <div>
          <span className={`text-[9px] uppercase font-bold tracking-widest px-2 py-0.5 rounded shadow-sm ${
            isExpenseMode 
              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20' 
              : (theme === 'dark' ? 'bg-zinc-800 text-zinc-300' : 'bg-zinc-100 text-zinc-700')
          }`}>
            {isExpenseMode ? 'Expense Control' : tracker.type === 'multi-year' ? `${tracker.yearsScale}-Year Schedule` : `${tracker.type} Schedule`}
          </span>
          <h3 className={`text-base font-bold mt-2 tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{tracker.name}</h3>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            {isExpenseMode ? 'Starting Budget' : 'Total Goal'}
          </div>
          <div className={`text-sm font-bold tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{totalGoal.toLocaleString()} <span className="text-[10px] font-bold opacity-50">BDT</span></div>
        </div>
      </div>

      <div className={`grid grid-cols-2 gap-4 border-y py-3.5 ${theme === 'dark' ? 'border-zinc-800/50' : 'border-zinc-100'}`}>
        <div>
          <div className="text-[10px] uppercase tracking-widest font-bold mb-1 text-zinc-500">
            {isExpenseMode ? 'Funds Remaining' : 'Money Saved'}
          </div>
          <div className={`text-2xl font-bold tracking-tight transition-colors ${
            isExpenseMode && savingsBalance < totalGoal * 0.2 ? 'text-rose-500 animate-pulse' : (theme === 'dark' ? 'text-white' : 'text-zinc-950')
          }`}>
            {savingsBalance.toLocaleString()} <span className="text-xs font-normal opacity-40">BDT</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-widest font-bold mb-1 text-zinc-500">
            {isExpenseMode ? 'Total Spent' : `Target / ${targetPeriodLabel}`}
          </div>
          <div className={`text-sm font-bold tracking-tight mt-1.5 ${isExpenseMode ? 'text-rose-500' : (theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600')}`}>
            {isExpenseMode ? (totalGoal - savingsBalance).toLocaleString() : microTarget.toLocaleString()} <span className="text-[10px] font-semibold opacity-50">BDT</span>
          </div>
        </div>
      </div>

      <div className={`space-y-3 p-4 rounded-xl border ${theme === 'dark' ? 'bg-black/40 border-zinc-900/60 shadow-[inset_0_2px_4px_rgba(0,0,0,0.4)]' : 'bg-zinc-50/50 border-zinc-200 shadow-[inset_0_2px_4px_rgba(0,0,0,0.05)]'}`}>
        {isExpenseMode ? (
          <div>
            <div className="flex justify-between text-[11px] mb-1.5 font-semibold">
              <span className={theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}>Budget Pool Health</span>
              <span className={`tracking-tight ${savingsBalance < totalGoal * 0.2 ? 'text-rose-600 font-bold' : 'text-emerald-600'}`}>{budgetRemainingPercent.toFixed(1)}% Left</span>
            </div>
            <div className={`w-full h-1.5 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
              <div 
                className={`h-full rounded-full transition-all duration-1000 ease-out ${
                  savingsBalance < totalGoal * 0.2 ? 'bg-rose-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, budgetRemainingPercent)}%` }}
              ></div>
            </div>
          </div>
        ) : (
          <>
            <div>
              <div className="flex justify-between text-[11px] mb-1.5 font-semibold">
                <span className={theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}>Current Schedule Progress</span>
                <span className={`tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{currentMilestonePercent.toFixed(1)}%</span>
              </div>
              <div className={`w-full h-1.5 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
                <div 
                  className={`h-full rounded-full transition-all duration-1000 ease-out ${
                    tracker.currentMilestoneSaved >= microTarget ? 'bg-gradient-to-r from-emerald-500 to-teal-400' : (theme === 'dark' ? 'bg-zinc-400' : 'bg-zinc-700')
                  }`}
                  style={{ width: `${Math.min(100, currentMilestonePercent)}%` }}
                ></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-[10px] mb-1 font-semibold uppercase tracking-wider">
                <span className="text-zinc-500">Macro Progress</span>
                <span className="tracking-tight text-zinc-500">{velocityGoalPercent.toFixed(1)}%</span>
              </div>
              <div className={`w-full h-1 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
                <div 
                  className={`h-full rounded-full transition-all duration-1000 ease-out ${theme === 'dark' ? 'bg-zinc-700' : 'bg-zinc-400'}`}
                  style={{ width: `${Math.min(100, velocityGoalPercent)}%` }}
                ></div>
              </div>
            </div>
          </>
        )}
      </div>

      {isExpenseMode ? (
        <div className={`text-xs py-2.5 px-3.5 rounded-xl flex items-center justify-between gap-3 border font-bold animate-fadeIn shadow-sm ${
          savingsBalance === 0 
            ? 'bg-rose-500/5 border-rose-500/20 text-rose-600 dark:text-rose-400'
            : savingsBalance < totalGoal * 0.2 
            ? 'bg-amber-500/5 border-amber-500/20 text-amber-600 dark:text-amber-400' 
            : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
        }`}>
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${savingsBalance < totalGoal * 0.2 ? 'bg-rose-500' : 'bg-emerald-500'}`}></span>
            {savingsBalance === 0 ? 'Critical: Budget depleted.' : savingsBalance < totalGoal * 0.2 ? `Warning: ${savingsBalance.toLocaleString()} BDT remaining.` : 'Status: Healthy pool allocation.'}
          </div>
          <button
            onClick={() => onSettle(tracker.id)}
            className={`text-[10px] uppercase tracking-widest font-bold px-2.5 py-1 rounded transition-all active:scale-95 ${
              theme === 'dark' ? 'bg-zinc-800 hover:bg-zinc-700 text-white' : 'bg-white hover:bg-zinc-100 border border-zinc-200 text-zinc-900'
            }`}
          >
            Renew Pool
          </button>
        </div>
      ) : (
        tracker.currentMilestoneSaved >= microTarget && (
          <div className="text-xs py-2.5 px-3.5 rounded-xl flex items-center justify-between gap-3 border font-bold animate-fadeIn bg-emerald-500/5 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 shadow-sm">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
              Milestone target achieved.
            </div>
            <button
              onClick={() => onSettle(tracker.id)}
              className={`text-[10px] uppercase tracking-widest font-bold px-2.5 py-1 rounded transition-all active:scale-95 ${
                theme === 'dark' ? 'bg-emerald-950 hover:bg-emerald-900 text-emerald-400 border border-emerald-800' : 'bg-white hover:bg-emerald-50 border border-emerald-200 text-emerald-700'
              }`}
            >
              Complete Cycle
            </button>
          </div>
        )
      )}

      <div className={`space-y-2 p-3 rounded-xl border ${theme === 'dark' ? 'bg-black/20 border-zinc-800/80' : 'bg-zinc-50 border-zinc-200'}`}>
        <div className="grid grid-cols-2 gap-2">
          <CurrencyInputWrapper theme={theme}>
            <input
              type="number"
              placeholder="0.00"
              value={logAmount}
              onChange={(e) => setLogAmount(e.target.value)}
              className={`w-full border rounded-lg pl-3 pr-14 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-colors ${
                theme === 'dark' ? 'bg-zinc-950 border-zinc-900 text-white placeholder:text-zinc-700' : 'bg-white border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
              }`}
            />
          </CurrencyInputWrapper>
          <input
            type="text"
            placeholder="Note (e.g., Rent)"
            value={logReason}
            onChange={(e) => setLogReason(e.target.value)}
            className={`border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-colors ${
              theme === 'dark' ? 'bg-zinc-950 border-zinc-900 text-white placeholder:text-zinc-700' : 'bg-white border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
            }`}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => submitLog('deposit')}
            className={`font-bold py-2 rounded-lg text-[11px] uppercase tracking-wider transition-all active:scale-[0.97] hover:-translate-y-0.5 shadow-sm hover:shadow-md ${
              theme === 'dark' ? 'bg-zinc-100 hover:bg-white text-black' : 'bg-zinc-950 hover:bg-zinc-900 text-white'
            }`}
          >
            {isExpenseMode ? 'Add Balance Funds' : 'Deposit Savings'}
          </button>
          <button
            type="button"
            onClick={() => submitLog('expense')}
            className="font-bold py-2 rounded-lg text-[11px] uppercase tracking-wider transition-all border bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 active:scale-[0.97] hover:-translate-y-0.5"
          >
            {isExpenseMode ? 'Log Pool Expense' : 'Log Withdrawal'}
          </button>
        </div>
      </div>

      {transactions.length > 0 && (
        <div className="pt-2 space-y-2 w-full">
          <span className="text-[9px] uppercase tracking-widest font-bold px-1 text-zinc-500">Transaction History</span>
          <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
            {transactions.map((tx) => (
              <div key={tx.id || Math.random().toString()} className={`border p-2.5 rounded-lg transition-all duration-300 hover:border-zinc-500/50 group/row ${
                theme === 'dark' ? 'bg-black/40 border-zinc-800/60' : 'bg-zinc-50/60 border-zinc-200'
              }`}>
                {editingTxId === tx.id ? (
                  <div className="space-y-2 animate-fadeIn">
                    <div className="grid grid-cols-2 gap-1.5">
                      <CurrencyInputWrapper theme={theme}>
                        <input 
                          type="number" value={editAmount} onChange={(e) => setEditAmount(e.target.value)}
                          className={`w-full border rounded px-2 pr-14 py-1 text-xs ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-white focus:border-emerald-500/50' : 'bg-white border-zinc-300'}`}
                        />
                      </CurrencyInputWrapper>
                      <input 
                        type="text" value={editReason} onChange={(e) => setEditReason(e.target.value)}
                        className={`border rounded px-2 py-1 text-xs ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-white focus:border-emerald-500/50' : 'bg-white border-zinc-300'}`}
                      />
                    </div>
                    <div className="flex justify-end gap-2 text-[10px] font-bold uppercase tracking-wider">
                      <button onClick={() => setEditingTxId(null)} className="px-2.5 py-1 rounded text-zinc-500 hover:bg-zinc-500/10">Cancel</button>
                      <button onClick={() => saveEdit(tx.id)} className="px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm">Save</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between items-center text-xs gap-2 transition-transform duration-300 group-hover/row:translate-x-0.5">
                    <div className="flex items-center gap-2 max-w-[55%] sm:max-w-[65%] overflow-hidden">
                      <span className={`text-[8px] font-black px-1 py-0.5 rounded shrink-0 ${
                        tx.type === 'deposit' 
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' 
                          : tx.type === 'settlement' 
                          ? 'bg-blue-950 text-blue-400 border border-blue-800' 
                          : 'bg-rose-950 text-rose-400 border border-rose-800'
                      }`}>
                        {tx.type === 'deposit' ? 'IN' : tx.type === 'settlement' ? 'RST' : 'OUT'}
                      </span>
                      <span className={`truncate font-medium ${theme === 'dark' ? 'text-zinc-300' : 'text-zinc-800'}`} title={tx.reason}>
                        {tx.reason || ''}
                      </span>
                    </div>
                    
                    <div className="text-right shrink-0 flex items-center gap-2">
                      <span className={`font-bold tracking-tight ${tx.type === 'deposit' ? 'text-emerald-500' : tx.type === 'settlement' ? 'text-blue-500' : 'text-rose-500'}`}>
                        {tx.type === 'deposit' ? '+' : tx.type === 'settlement' ? '// ' : '-'}{(tx.amount || 0).toLocaleString()} <span className="text-[9px] font-semibold opacity-60">BDT</span>
                      </span>
                      <span className="text-[10px] hidden sm:inline-block w-12 text-right text-zinc-500">
                        {new Date(tx.timestamp || Date.now()).toLocaleDateString('en-BD', { month: 'short', day: 'numeric' })}
                      </span>
                      
                      {tx.type !== 'settlement' && (
                        <div className="flex items-center gap-1.5 opacity-100 sm:opacity-0 sm:group-hover/row:opacity-100 transition-opacity">
                          <button onClick={() => startEditing(tx)} className="text-[10px] text-zinc-500 hover:text-amber-500 font-bold uppercase tracking-wider" title="Edit Entry">Edit</button>
                          <button onClick={() => onDeleteTx(tracker.id, tx.id)} className="text-[10px] text-zinc-500 hover:text-rose-500 font-bold uppercase tracking-wider" title="Delete Entry">[x]</button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default App;