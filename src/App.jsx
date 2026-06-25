import React, { useState, useEffect } from 'react';
import { auth, db } from './firebase';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';

function App() {
  // --- Core Theme Configuration ---
  const [theme, setTheme] = useState(() => localStorage.getItem('pt-theme') || 'dark');

  // --- Auth States ---
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  // --- Form Input States ---
  const [trackerName, setTrackerName] = useState('');
  const [timelineType, setTimelineType] = useState('monthly'); // weekly, monthly, yearly, multi-year, expense-control
  const [customYears, setCustomYears] = useState('2'); 
  const [startPeriod, setStartPeriod] = useState(() => {
    const today = new Date();
    return today.toISOString().split('T')[0]; 
  });
  const [targetAmount, setTargetAmount] = useState('');
  const [incomeBase, setIncomeBase] = useState('');

  // --- Master App Storage State ---
  const [trackers, setTrackers] = useState([]);

  // --- Sync Theme ---
  useEffect(() => {
    localStorage.setItem('pt-theme', theme);
  }, [theme]);

  // --- Auth Listener ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  // --- Cloud Snapshot Sync ---
  useEffect(() => {
    if (!user) {
      setTrackers([]);
      return;
    }
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
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      setEmail('');
      setPassword('');
    } catch (error) {
      alert(error.message);
    }
  };

  const saveTrackersToCloud = async (updatedList) => {
    if (!user) return;
    try {
      await setDoc(doc(db, "users", user.uid), { trackers: updatedList }, { merge: true });
    } catch (error) {
      console.error("Cloud synchronization mismatch:", error);
    }
  };

  const calculatePaceMetrics = (type, goalVal, yearsCount) => {
    const totalGoal = parseFloat(goalVal) || 0;
    if (totalGoal <= 0) return { divisorLabel: 'period', microTarget: 0 };

    switch(type) {
      case 'expense-control':
        return { divisorLabel: 'month pool', microTarget: totalGoal };
      case 'weekly':
        return { divisorLabel: 'week', microTarget: totalGoal };
      case 'monthly':
        return { divisorLabel: 'month', microTarget: totalGoal };
      case 'yearly':
        return { divisorLabel: 'month', microTarget: parseFloat((totalGoal / 12).toFixed(0)) };
      case 'multi-year':
        const totalMonths = (parseInt(yearsCount) || 2) * 12;
        return { divisorLabel: 'month', microTarget: parseFloat((totalGoal / totalMonths).toFixed(0)) };
      default:
        return { divisorLabel: 'period', microTarget: totalGoal };
    }
  };

  const handleCreateTracker = (e) => {
    e.preventDefault();
    if (!trackerName || !targetAmount) return;

    const goalVal = parseFloat(targetAmount);
    const { divisorLabel, microTarget } = calculatePaceMetrics(timelineType, goalVal, customYears);

    // If it's an expense tracker, the starting balance is the FULL amount allocated
    const startingBalance = timelineType === 'expense-control' ? goalVal : 0;

    const newTracker = {
      id: Date.now().toString(),
      name: trackerName,
      type: timelineType,
      yearsScale: timelineType === 'multi-year' ? parseInt(customYears) : 1,
      startPeriod: startPeriod,
      totalGoal: goalVal,
      incomeBase: parseFloat(incomeBase) || 0,
      microTarget: microTarget,
      targetPeriodLabel: divisorLabel,
      savingsBalance: startingBalance, 
      currentMilestoneSaved: startingBalance, 
      transactions: []   
    };

    const updated = [...trackers, newTracker];
    setTrackers(updated);
    saveTrackersToCloud(updated);
    
    setTrackerName('');
    setTargetAmount('');
    setIncomeBase('');
  };

  // Recalculates metrics sequentially from transactions to perfectly handle edits/deletions
  const recalculateTrackerBalances = (tracker) => {
    const isExpenseMode = tracker.type === 'expense-control';
    const baseBalance = isExpenseMode ? tracker.totalGoal : 0;
    
    let currentBalance = baseBalance;
    let currentMilestone = baseBalance;

    // Process from oldest to newest transaction to build correct running totals
    const reversedTx = [...tracker.transactions].reverse();
    
    reversedTx.forEach((tx) => {
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

    return {
      ...tracker,
      savingsBalance: currentBalance,
      currentMilestoneSaved: currentMilestone
    };
  };

  const handleLogTransaction = (trackerId, type, amountValue, reasonText) => {
    const numAmount = parseFloat(amountValue);
    if (isNaN(numAmount) || numAmount <= 0) return;

    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const newTx = {
          id: Date.now().toString(),
          type: type,
          amount: numAmount,
          reason: reasonText || (type === 'deposit' ? 'Added funds' : 'Logged expense'),
          date: new Date().toLocaleDateString('en-BD', { month: 'short', day: 'numeric' })
        };
        const updatedTrack = {
          ...track,
          transactions: [newTx, ...(track.transactions || [])]
        };
        return recalculateTrackerBalances(updatedTrack);
      }
      return track;
    });

    setTrackers(updated);
    saveTrackersToCloud(updated);
  };

  const handleEditTransaction = (trackerId, transactionId, newAmount, newReason) => {
    const numAmount = parseFloat(newAmount);
    if (isNaN(numAmount) || numAmount <= 0) return;

    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const updatedTxList = track.transactions.map((tx) => {
          if (tx.id === transactionId) {
            return { ...tx, amount: numAmount, reason: newReason };
          }
          return tx;
        });
        return recalculateTrackerBalances({ ...track, transactions: updatedTxList });
      }
      return track;
    });

    setTrackers(updated);
    saveTrackersToCloud(updated);
  };

  const handleDeleteTransaction = (trackerId, transactionId) => {
    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const updatedTxList = track.transactions.filter((tx) => tx.id !== transactionId);
        return recalculateTrackerBalances({ ...track, transactions: updatedTxList });
      }
      return track;
    });

    setTrackers(updated);
    saveTrackersToCloud(updated);
  };

  const handleDeleteTracker = (trackerId) => {
    if (!window.confirm("Are you sure you want to completely remove this tracker?")) return;
    const updated = trackers.filter((t) => t.id !== trackerId);
    setTrackers(updated);
    saveTrackersToCloud(updated);
  };

  const handleSettleMilestone = (trackerId) => {
    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const isExpenseMode = track.type === 'expense-control';
        const updatedTrack = {
          ...track,
          transactions: [{
            id: Date.now().toString(),
            type: 'settlement',
            amount: isExpenseMode ? track.savingsBalance : (track.microTarget || 0),
            reason: isExpenseMode ? `🔄 Monthly budget rolled over & renewed` : `🎉 Period goals completed`,
            date: new Date().toLocaleDateString('en-BD', { month: 'short', day: 'numeric' })
          }, ...(track.transactions || [])]
        };
        return recalculateTrackerBalances(updatedTrack);
      }
      return track;
    });
    setTrackers(updated);
    saveTrackersToCloud(updated);
  };

  const currentPreview = calculatePaceMetrics(timelineType, targetAmount, customYears);
  const incomeNum = parseFloat(incomeBase) || 0;
  const incomePercentage = incomeNum > 0 ? ((currentPreview.microTarget / incomeNum) * 100).toFixed(1) : 0;

  if (authLoading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${theme === 'dark' ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
        <div className={`h-6 w-6 rounded-full border-2 border-transparent animate-spin ${theme === 'dark' ? 'border-t-white' : 'border-t-zinc-900'}`}></div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen transition-colors duration-300 antialiased flex flex-col items-center p-4 sm:p-6 select-none ${
      theme === 'dark' ? 'bg-zinc-950 text-zinc-100 selection:bg-emerald-500/20' : 'bg-zinc-50 text-zinc-900 selection:bg-emerald-500/10'
    }`}>
      
      {!user ? (
        <div className="w-full max-w-sm my-auto space-y-6 animate-fadeIn">
          <div className="text-center space-y-1">
            <h1 className={`text-2xl font-black tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>PaceTrack</h1>
            <p className="text-zinc-500 text-xs font-medium">Track your finances</p>
          </div>

          <form onSubmit={handleAuth} className={`border p-6 rounded-2xl shadow-2xl space-y-4 backdrop-blur-md transition-all duration-300 ${
            theme === 'dark' ? 'bg-zinc-900/40 border-zinc-900' : 'bg-white border-zinc-200'
          }`}>
            <h2 className="text-xs font-bold tracking-widest uppercase text-zinc-400">
              {isRegistering ? 'Create your account' : 'Welcome back'}
            </h2>

            <div className="space-y-3">
              <input
                type="email"
                placeholder="Your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`w-full border rounded-xl px-4 py-3 text-sm focus:outline-none transition-all font-medium ${
                  theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-700 placeholder:text-zinc-600' : 'bg-zinc-100/80 border-zinc-200 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-400'
                }`}
                required
              />
              <input
                type="password"
                placeholder="Secure password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`w-full border rounded-xl px-4 py-3 text-sm focus:outline-none transition-all font-medium ${
                  theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-700 placeholder:text-zinc-600' : 'bg-zinc-100/80 border-zinc-200 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-400'
                }`}
                required
              />
            </div>

            <button
              type="submit"
              className={`w-full font-bold py-3 rounded-xl text-xs transition-all tracking-wide active:scale-[0.98] hover:opacity-90 shadow-md ${
                theme === 'dark' ? 'bg-white hover:bg-zinc-200 text-black' : 'bg-zinc-950 hover:bg-zinc-800 text-white'
              }`}
            >
              {isRegistering ? 'Register account' : 'Sign in to dashboard'}
            </button>

            <div className="text-center pt-1">
              <button
                type="button"
                onClick={() => setIsRegistering(!isRegistering)}
                className="text-xs text-zinc-500 hover:text-zinc-400 transition-colors font-medium underline underline-offset-4"
              >
                {isRegistering ? 'Have an account? Log in' : "Don't have an account? Sign up"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="w-full max-w-md space-y-6 animate-fadeIn">
          
          <header className={`w-full flex justify-between items-center py-5 border-b transition-all ${
            theme === 'dark' ? 'border-zinc-900' : 'border-zinc-200'
          }`}>
            <div>
              <h1 className={`text-xl font-black tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>PaceTrack</h1>
              <span className="text-[10px] text-zinc-500 font-mono flex items-center gap-1 mt-0.5">
                <span className="h-1 w-1 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]"></span>
                {user.email}
              </span>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className={`p-2 rounded-xl border text-xs font-bold transition-all active:scale-90 ${
                  theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-white' : 'bg-white border-zinc-200 text-zinc-600 hover:text-zinc-950'
                }`}
              >
                {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
              </button>
              
              <button 
                onClick={() => signOut(auth)}
                className={`text-[10px] uppercase font-bold tracking-widest border px-3 py-2 rounded-xl transition-all active:scale-95 ${
                  theme === 'dark' ? 'bg-zinc-900/20 border-zinc-900 text-zinc-500 hover:text-rose-400 hover:border-rose-950' : 'bg-white border-zinc-200 text-zinc-500 hover:text-rose-600 hover:border-rose-200'
                }`}
              >
                Exit
              </button>
            </div>
          </header>

          <form onSubmit={handleCreateTracker} className={`border p-5 rounded-2xl shadow-xl space-y-4 transition-all ${
            theme === 'dark' ? 'bg-zinc-900/40 border-zinc-900' : 'bg-white border-zinc-200 shadow-zinc-200/60'
          }`}>
            <h2 className="text-xs font-bold tracking-widest uppercase text-zinc-400">Set up your tracker</h2>
            
            <div className="space-y-3.5">
              <input
                type="text"
                placeholder="Goal name (e.g., Household Savings, New Laptop)"
                value={trackerName}
                onChange={(e) => setTrackerName(e.target.value)}
                className={`w-full border rounded-xl px-4 py-3 text-sm focus:outline-none transition-all font-medium ${
                  theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-700 placeholder:text-zinc-600' : 'bg-zinc-50 border-zinc-200 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-400'
                }`}
                required
              />

              <div>
                <label className="block text-[9px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5 px-0.5">Tracking schedule</label>
                <div className={`grid grid-cols-5 gap-1 p-1 rounded-xl border ${
                  theme === 'dark' ? 'bg-zinc-900/80 border-zinc-800/60' : 'bg-zinc-100 border-zinc-200/60'
                }`}>
                  {['weekly', 'monthly', 'yearly', 'multi-year', 'expense-control'].map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setTimelineType(mode)}
                      className={`py-2 text-[9px] font-bold rounded-lg transition-all text-center ${
                        timelineType === mode 
                          ? (theme === 'dark' ? 'bg-zinc-800 text-white shadow-sm font-black' : 'bg-white text-zinc-950 shadow-sm font-black') 
                          : 'text-zinc-500 hover:text-zinc-400'
                      }`}
                    >
                      {mode === 'expense-control' ? 'expense' : mode.replace('-', ' ')}
                    </button>
                  ))}
                </div>
              </div>

              {timelineType === 'multi-year' && (
                <div className="bg-black/10 p-3 rounded-xl border border-zinc-800/40 flex items-center justify-between animate-fadeIn">
                  <div>
                    <label className="block text-[9px] font-bold text-zinc-500 uppercase tracking-widest">Time scale</label>
                    <span className="text-xs text-zinc-400 font-medium">Set tracking duration up to 10 years.</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input 
                      type="range" min="2" max="10" 
                      value={customYears} 
                      onChange={(e) => setCustomYears(e.target.value)}
                      className="accent-white w-20 cursor-pointer"
                    />
                    <span className="text-xs font-mono font-bold bg-zinc-800 px-2 py-0.5 rounded text-white">{customYears} years</span>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[9px] font-bold text-zinc-500 uppercase tracking-widest mb-1 px-0.5">Start date</label>
                  <input
                    type="date"
                    value={startPeriod}
                    onChange={(e) => setStartPeriod(e.target.value)}
                    className={`w-full border rounded-xl px-3 py-2.5 text-xs focus:outline-none font-mono ${
                      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-700' : 'bg-zinc-50 border-zinc-200 text-zinc-900 focus:border-zinc-400'
                    }`}
                  />
                </div>
                <div>
                  <label className="block text-[9px] font-bold text-zinc-500 uppercase tracking-widest mb-1 px-0.5">
                    {timelineType === 'expense-control' ? 'Monthly budget limit' : 'Target savings goal'}
                  </label>
                  <input
                    type="number"
                    placeholder={timelineType === 'expense-control' ? 'e.g., 40000' : 'e.g., 500000'}
                    value={targetAmount}
                    onChange={(e) => setTargetAmount(e.target.value)}
                    className={`w-full border rounded-xl px-3 py-2.5 text-xs focus:outline-none font-mono ${
                      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-700 placeholder:text-zinc-700' : 'bg-zinc-50 border-zinc-200 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-300'
                    }`}
                    required
                  />
                </div>
              </div>

              {timelineType !== 'expense-control' && (
                <div className="space-y-1">
                  <label className="block text-[9px] font-bold text-zinc-500 uppercase tracking-widest px-0.5">Monthly salary or income (Optional)</label>
                  <input
                    type="number"
                    placeholder="e.g., 50000 BDT"
                    value={incomeBase}
                    onChange={(e) => setIncomeBase(e.target.value)}
                    className={`w-full border rounded-xl px-4 py-3 text-sm focus:outline-none transition-all font-mono ${
                      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-700 placeholder:text-zinc-600' : 'bg-zinc-50 border-zinc-200 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-300'
                    }`}
                  />
                </div>
              )}

              <button
                type="submit"
                className={`w-full font-bold py-3 rounded-xl text-xs transition-all tracking-wide active:scale-[0.98] hover:opacity-90 shadow-md ${
                  theme === 'dark' ? 'bg-white hover:bg-zinc-200 text-black' : 'bg-zinc-950 hover:bg-zinc-800 text-white'
                }`}
              >
                Create budget plan
              </button>
            </div>
          </form>

          {targetAmount > 0 && timelineType !== 'expense-control' && (
            <div className={`border p-4 rounded-xl flex justify-between items-center animate-fadeIn ${
              theme === 'dark' ? 'bg-zinc-900/20 border-dashed border-zinc-800/80' : 'bg-zinc-100/50 border-dashed border-zinc-200'
            }`}>
              <div>
                <div className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">Required breakdown goal</div>
                <div className={`text-lg font-black font-mono ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>
                  {parseInt(currentPreview.microTarget).toLocaleString()} BDT
                  <span className="text-[10px] font-normal text-zinc-500">/{currentPreview.divisorLabel}</span>
                </div>
              </div>
              {incomeNum > 0 && (
                <div className="text-right">
                  <div className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">Budget strain</div>
                  <div className="text-sm font-bold text-emerald-500 font-mono">{incomePercentage}%</div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div className="flex justify-between items-center px-0.5">
              <h2 className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Active budgets</h2>
              <span className="text-xs text-zinc-500 font-mono">Total trackers: {trackers.length}</span>
            </div>
            
            {trackers.length === 0 ? (
              <div className={`text-center py-10 border border-dashed rounded-2xl ${
                theme === 'dark' ? 'bg-zinc-900/10 border-zinc-900' : 'bg-zinc-100/20 border-zinc-200'
              }`}>
                <p className="text-xs text-zinc-400 tracking-wide">No active tracking schedules. Create your first one above!</p>
              </div>
            ) : (
              <div className="space-y-5">
                {trackers.map((item) => (
                  <ActiveTrackerCard 
                    key={item.id} 
                    tracker={item} 
                    theme={theme}
                    onLog={handleLogTransaction} 
                    onEditTx={handleEditTransaction}
                    onDeleteTx={handleDeleteTransaction}
                    onDeleteTracker={handleDeleteTracker}
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

function ActiveTrackerCard({ tracker, theme, onLog, onEditTx, onDeleteTx, onDeleteTracker, onSettle }) {
  const [logAmount, setLogAmount] = useState('');
  const [logReason, setLogReason] = useState('');
  
  // States to facilitate row editing features
  const [editingTxId, setEditingTxId] = useState(null);
  const [editAmount, setEditAmount] = useState('');
  const [editReason, setEditReason] = useState('');

  const isExpenseMode = tracker.type === 'expense-control';

  const totalGoal = tracker.totalGoal || 0;
  const savingsBalance = tracker.savingsBalance !== undefined ? tracker.savingsBalance : 0;
  const microTarget = tracker.microTarget || 0;
  const targetPeriodLabel = tracker.targetPeriodLabel || 'month';
  const transactions = tracker.transactions || [];

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
    <div className={`border p-5 rounded-2xl shadow-xl space-y-4 backdrop-blur-md transition-all duration-300 transform hover:-translate-y-0.5 animate-fadeIn relative group ${
      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 hover:border-zinc-700/60 shadow-black/40' : 'bg-white border-zinc-200/80 hover:border-zinc-300 shadow-zinc-200/40'
    }`}>
      
      {/* Absolute Tracker Container Delete Button */}
      <button 
        onClick={() => onDeleteTracker(tracker.id)}
        className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-rose-500 transition-opacity duration-200 text-xs p-1"
        title="Remove entire budget tracker"
      >
        🗑️
      </button>

      <div className="flex justify-between items-start pr-4">
        <div>
          <span className={`text-[8px] uppercase font-mono tracking-widest px-2 py-0.5 rounded font-bold ${
            isExpenseMode 
              ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' 
              : (theme === 'dark' ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-500')
          }`}>
            {isExpenseMode ? 'expense control' : tracker.type === 'multi-year' ? `${tracker.yearsScale}-year schedule` : `${tracker.type} schedule`}
          </span>
          <h3 className={`text-base font-black mt-1.5 tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{tracker.name}</h3>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">
            {isExpenseMode ? 'starting budget' : 'total goal'}
          </div>
          <div className={`text-sm font-black font-mono ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{totalGoal.toLocaleString()} BDT</div>
        </div>
      </div>

      <div className={`grid grid-cols-2 gap-4 border-y py-3.5 ${theme === 'dark' ? 'border-zinc-900' : 'border-zinc-100'}`}>
        <div>
          <div className="text-[9px] text-zinc-400 uppercase tracking-widest font-bold mb-0.5">
            {isExpenseMode ? 'funds remaining' : 'total money saved'}
          </div>
          <div className={`text-lg font-black font-mono ${
            isExpenseMode && savingsBalance < totalGoal * 0.2 ? 'text-rose-500 animate-pulse' : (theme === 'dark' ? 'text-white' : 'text-zinc-950')
          }`}>
            {savingsBalance.toLocaleString()} <span className="text-xs font-normal text-zinc-500">BDT</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[9px] text-zinc-400 uppercase tracking-widest font-bold mb-0.5">
            {isExpenseMode ? 'total spent' : `target amount / ${targetPeriodLabel}`}
          </div>
          <div className={`text-sm font-black font-mono ${isExpenseMode ? 'text-rose-500' : (theme === 'dark' ? 'text-zinc-300' : 'text-zinc-700')}`}>
            {isExpenseMode ? (totalGoal - savingsBalance).toLocaleString() : microTarget.toLocaleString()} BDT
          </div>
        </div>
      </div>

      <div className={`space-y-3.5 p-4 rounded-xl border ${theme === 'dark' ? 'bg-black/40 border-zinc-900/60' : 'bg-zinc-50/50 border-zinc-100'}`}>
        {isExpenseMode ? (
          <div>
            <div className="flex justify-between text-[11px] mb-1.5 font-semibold">
              <span className="text-zinc-400">Budget pool health</span>
              <span className={`font-mono ${savingsBalance < totalGoal * 0.2 ? 'text-rose-500' : 'text-emerald-500'}`}>{budgetRemainingPercent.toFixed(1)}% remaining</span>
            </div>
            <div className={`w-full h-2 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
              <div 
                className={`h-2 rounded-full transition-all duration-500 ease-out ${
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
                <span className="text-zinc-400">Current schedule progress</span>
                <span className={`font-mono ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{currentMilestonePercent.toFixed(1)}%</span>
              </div>
              <div className={`w-full h-2 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
                <div 
                  className={`h-2 rounded-full transition-all duration-500 ease-out ${
                    tracker.currentMilestoneSaved >= microTarget ? 'bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : (theme === 'dark' ? 'bg-white' : 'bg-zinc-950')
                  }`}
                  style={{ width: `${Math.min(100, currentMilestonePercent)}%` }}
                ></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-[11px] mb-1.5 font-semibold">
                <span className="text-zinc-400">Overall tracking progress</span>
                <span className="font-mono text-zinc-400">{velocityGoalPercent.toFixed(1)}%</span>
              </div>
              <div className={`w-full h-1.5 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
                <div 
                  className={`h-1.5 rounded-full transition-all duration-500 ease-out ${theme === 'dark' ? 'bg-zinc-600' : 'bg-zinc-400'}`}
                  style={{ width: `${Math.min(100, velocityGoalPercent)}%` }}
                ></div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Dynamic Alerts */}
      {isExpenseMode ? (
        <div className={`text-[11px] py-2 px-3 rounded-xl flex items-center justify-between border font-bold animate-fadeIn ${
          savingsBalance === 0 
            ? 'bg-rose-500/10 border-rose-500/20 text-rose-500'
            : savingsBalance < totalGoal * 0.2 
            ? 'bg-amber-500/5 border-amber-500/20 text-amber-500' 
            : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-500'
        }`}>
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${savingsBalance < totalGoal * 0.2 ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}`}></span>
            {savingsBalance === 0 
              ? 'Alert: Running budget empty. Try to slow down expenses.'
              : savingsBalance < totalGoal * 0.2
              ? `Warning: Running low. Only ${savingsBalance.toLocaleString()} BDT left.`
              : 'Status: Healthy budget balance.'
            }
          </div>
          <button
            onClick={() => onSettle(tracker.id)}
            className={`text-[9px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded transition-all active:scale-90 ${
              theme === 'dark' ? 'bg-zinc-800 hover:bg-zinc-700 text-white' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-900'
            }`}
            title="Renew pool allocation for next schedule cycle"
          >
            Next month 🔄
          </button>
        </div>
      ) : (
        tracker.currentMilestoneSaved >= microTarget && (
          <div className="text-[11px] py-2 px-3 rounded-xl flex items-center justify-between border font-bold animate-fadeIn bg-emerald-500/5 border-emerald-500/20 text-emerald-500">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              Periodic milestone goal achieved!
            </div>
            <button
              onClick={() => onSettle(tracker.id)}
              className={`text-[9px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded transition-all active:scale-90 ${
                theme === 'dark' ? 'bg-emerald-950 hover:bg-emerald-900 text-emerald-400' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-700'
              }`}
            >
              Complete period ✓
            </button>
          </div>
        )
      )}

      {/* Transaction Entry Panel */}
      <div className={`space-y-2 p-2.5 rounded-xl border ${theme === 'dark' ? 'bg-black/20 border-zinc-900' : 'bg-zinc-50 border-zinc-200'}`}>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            placeholder="Amount in BDT"
            value={logAmount}
            onChange={(e) => setLogAmount(e.target.value)}
            className={`border rounded-lg px-3 py-2 text-xs focus:outline-none font-mono transition-colors ${
              theme === 'dark' ? 'bg-zinc-950 border-zinc-900 focus:bg-zinc-900 focus:border-zinc-800 text-white placeholder:text-zinc-600' : 'bg-white border-zinc-200 focus:border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
            }`}
          />
          <input
            type="text"
            placeholder="Note (e.g., Groceries)"
            value={logReason}
            onChange={(e) => setLogReason(e.target.value)}
            className={`border rounded-lg px-3 py-2 text-xs focus:outline-none transition-colors ${
              theme === 'dark' ? 'bg-zinc-950 border-zinc-900 focus:bg-zinc-900 focus:border-zinc-800 text-white placeholder:text-zinc-600' : 'bg-white border-zinc-200 focus:border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
            }`}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => submitLog('deposit')}
            className={`font-bold py-2 rounded-lg text-[11px] transition-all active:scale-[0.97] shadow-sm ${
              theme === 'dark' ? 'bg-zinc-100 hover:bg-white text-black' : 'bg-zinc-950 hover:bg-zinc-900 text-white'
            }`}
          >
            {isExpenseMode ? 'Add extra funds' : 'Log savings deposit'}
          </button>
          <button
            type="button"
            onClick={() => submitLog('expense')}
            className="font-bold py-2 rounded-lg text-[11px] transition-all border bg-rose-500/10 border-rose-500/20 text-rose-500 hover:bg-rose-500/20 active:scale-[0.97]"
          >
            {isExpenseMode ? 'Log an expense' : 'Log a withdrawal'}
          </button>
        </div>
      </div>

      {transactions.length > 0 && (
        <div className="pt-1 space-y-1">
          <span className="text-[9px] uppercase tracking-wider text-zinc-500 font-bold px-0.5">History logs</span>
          <div className="max-h-36 overflow-y-auto space-y-1.5 pr-0.5 custom-scrollbar">
            {transactions.map((tx) => (
              <div key={tx.id || Math.random().toString()} className={`border p-2 rounded-lg transition-all ${
                theme === 'dark' ? 'bg-black/40 border-zinc-900/60' : 'bg-zinc-50/60 border-zinc-100/80'
              }`}>
                {editingTxId === tx.id ? (
                  /* Inline Edit Mode Interface Row */
                  <div className="space-y-2 animate-fadeIn">
                    <div className="grid grid-cols-2 gap-1.5">
                      <input 
                        type="number" 
                        value={editAmount} 
                        onChange={(e) => setEditAmount(e.target.value)}
                        className={`border rounded px-2 py-1 text-xs font-mono ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-white' : 'bg-white border-zinc-300'}`}
                      />
                      <input 
                        type="text" 
                        value={editReason} 
                        onChange={(e) => setEditReason(e.target.value)}
                        className={`border rounded px-2 py-1 text-xs ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-white' : 'bg-white border-zinc-300'}`}
                      />
                    </div>
                    <div className="flex justify-end gap-1.5 text-[10px]">
                      <button 
                        onClick={() => setEditingTxId(null)} 
                        className="px-2 py-0.5 rounded border border-zinc-500 text-zinc-400 hover:text-zinc-300"
                      >
                        Cancel
                      </button>
                      <button 
                        onClick={() => saveEdit(tx.id)} 
                        className="px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-500"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Standard Log Display Row with Action Badges */
                  <div className="flex justify-between items-center text-[11px] font-mono group/row">
                    <div className="flex items-center gap-2 max-w-[65%]">
                      <span className={`text-[8px] font-extrabold px-1 rounded shrink-0 ${
                        tx.type === 'deposit' 
                          ? 'bg-emerald-950 text-emerald-400' 
                          : tx.type === 'settlement' 
                          ? 'bg-blue-950 text-blue-400' 
                          : 'bg-rose-950 text-rose-400'
                      }`}>
                        {tx.type === 'deposit' ? 'IN' : tx.type === 'settlement' ? 'RESET' : 'OUT'}
                      </span>
                      <span className={`truncate ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`} title={tx.reason}>
                        {tx.reason || ''}
                      </span>
                    </div>
                    
                    <div className="text-right shrink-0 flex items-center gap-2">
                      <span className={`font-bold ${
                        tx.type === 'deposit' ? 'text-emerald-500' : tx.type === 'settlement' ? 'text-blue-400' : 'text-rose-500'
                      }`}>
                        {tx.type === 'deposit' ? '+' : tx.type === 'settlement' ? '✓' : '-'}{(tx.amount || 0).toLocaleString()}
                      </span>
                      <span className="text-[9px] text-zinc-500">{tx.date || ''}</span>
                      
                      {/* Inline Row Quick-Actions Controls */}
                      {tx.type !== 'settlement' && (
                        <div className="flex items-center gap-1 ml-1 md:opacity-0 group-hover/row:opacity-100 transition-opacity">
                          <button 
                            onClick={() => startEditing(tx)} 
                            className="text-zinc-400 hover:text-amber-500 transition-colors px-0.5 text-[10px]"
                            title="Edit entry"
                          >
                            ✏️
                          </button>
                          <button 
                            onClick={() => onDeleteTx(tracker.id, tx.id)} 
                            className="text-zinc-400 hover:text-rose-500 transition-colors px-0.5 text-[10px]"
                            title="Delete entry"
                          >
                            ❌
                          </button>
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
}

export default App;