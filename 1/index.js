// 账单记录系统 - Cloudflare Workers 脚本 (汇率增强版 - 修复计算偏差)
// 功能：手工录入账单，统计当月/当年/各类型金额，登录验证，导出/导入表格，汇率换算统计
// 修复：登录过期自动跳转、导入日期格式兼容、数据格式兼容、汇率计算基准统一

// 默认密码（仅作演示，生产环境建议使用更安全的方式）
const VALID_PASSWORD = "ccc9912345";
const USERNAME = "admin";

// 币种符号映射
const CURRENCY_SYMBOLS = {
  "CNY": "￥",
  "USD": "$",
  "JPY": "JP¥",
  "KRW": "₩",
  "AED": "AED ",
  "TWD": "NT$",
  "HKD": "HK$",
  "GBP": "£",
  "EUR": "€",
  "HUF": "Ft ",
  "SAR": "SR "
};

// 币种名称映射（中文/英文）
const CURRENCY_NAMES = {
  "CNY": "人民币/CNY",
  "USD": "美金/USD",
  "JPY": "日元/JPY",
  "KRW": "韩币/KRW",
  "AED": "迪拉姆/AED",
  "TWD": "新台币/TWD",
  "HKD": "港币/HKD",
  "GBP": "英镑/GBP",
  "EUR": "欧元/EUR",
  "HUF": "福林/HUF",
  "SAR": "里亚尔/SAR"
};

// 消费类型列表（中英文）
const EXPENSE_TYPES = [
  { chinese: "餐饮", english: "Food" },
  { chinese: "购物", english: "Shopping" },
  { chinese: "交通", english: "Transport" },
  { chinese: "住宿", english: "Accommodation" },
  { chinese: "通信", english: "Communication" },
  { chinese: "停车", english: "Parking" },
  { chinese: "娱乐", english: "Entertainment" },
  { chinese: "其他", english: "Other" }
];

// 内存缓存 - 按年份缓存
let billsCache = {
  _all: null
};
let cacheTimestamp = 0;
const CACHE_TTL = 30000;

export default {
  async fetch(request, env, ctx) {
    // 统一处理CORS预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 简单路由
      if (path === "/" || path === "/index.html") {
        return serveHtml();
      } else if (path === "/api/login" && request.method === "POST") {
        return await handleLogin(request);
      } else if (path === "/api/rates" && request.method === "GET") {
        return await getExchangeRates();
      } else if (path === "/api/bills" && request.method === "GET") {
        const auth = checkAuth(request);
        if (!auth.passed) return auth.response;
        return await getBills(env);
      } else if (path === "/api/bills" && request.method === "POST") {
        const auth = checkAuth(request);
        if (!auth.passed) return auth.response;
        return await addBill(request, env);
      } else if (path === "/api/bills/export" && request.method === "POST") {
        const auth = checkAuth(request);
        if (!auth.passed) return auth.response;
        return await exportBills(request, env);
      } else if (path === "/api/bills/import" && request.method === "POST") {
        const auth = checkAuth(request);
        if (!auth.passed) return auth.response;
        return await importBills(request, env);
      } else if (path === "/api/stats" && request.method === "POST") {
        const auth = checkAuth(request);
        if (!auth.passed) return auth.response;
        return await getStats(request, env);
      } else if (path === "/api/bills" && request.method === "DELETE") {
        const auth = checkAuth(request);
        if (!auth.passed) return auth.response;
        return await deleteBill(request, env);
      } else if (path === "/api/bills/batch" && request.method === "POST") {
        const auth = checkAuth(request);
        if (!auth.passed) return auth.response;
        return await batchBills(request, env);
      }

      return new Response("Not Found", { status: 404, headers: CORS_HEADERS() });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500, 
        headers: { "Content-Type": "application/json", ...CORS_HEADERS() } 
      });
    }
  }
};

// CORS 头辅助
function CORS_HEADERS() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// 获取汇率 - 使用免费API
async function getExchangeRates() {
  try {
    // 使用 exchangerate-api.com 的免费端点
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    
    if (!response.ok) {
      throw new Error('Failed to fetch rates');
    }
    
    const data = await response.json();
    
    // 确保基准是 USD
    if (data.base !== 'USD') {
      // 如果基准不是USD，需要转换（虽然这个API默认是USD，但做个保险）
      // 此处省略基准转换逻辑，因为该API通常返回USD基准
    }
    
    return new Response(JSON.stringify({
      base: 'USD',
      date: data.date,
      rates: data.rates
    }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS() }
    });
  } catch (error) {
    // 【修复】备用汇率必须是以 1 USD 为基准
    // 例如：1 USD = 7.24 CNY, 1 USD = 154.5 JPY
    const fallbackRates = {
      "USD": 1,        // 基准
      "CNY": 7.24,     // 1 美元 ≈ 7.24 人民币
      "JPY": 154.5,    // 1 美元 ≈ 154.5 日元
      "KRW": 1360,     // 1 美元 ≈ 1360 韩币
      "EUR": 0.92,     // 1 美元 ≈ 0.92 欧元
      "GBP": 0.79,     // 1 美元 ≈ 0.79 英镑
      "HKD": 7.82,     // 1 美元 ≈ 7.82 港币
      "TWD": 32.5,     // 1 美元 ≈ 32.5 新台币
      "AED": 3.67,     // 1 美元 ≈ 3.67 迪拉姆
      "SAR": 3.75,     // 1 美元 ≈ 3.75 里亚尔
      "HUF": 360       // 1 美元 ≈ 360 福林
    };
    
    return new Response(JSON.stringify({
      base: 'USD',
      date: new Date().toISOString().slice(0, 10),
      rates: fallbackRates,
      isFallback: true
    }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS() }
    });
  }
}

// 提供前端HTML界面
function serveHtml() {
  // 生成类型选项HTML
  const typeOptionsHtml = EXPENSE_TYPES.map(type => 
    `<option value="${type.chinese}">${type.chinese} / ${type.english}</option>`
  ).join('');

  // 生成类型筛选复选框HTML
  const typeCheckboxesHtml = EXPENSE_TYPES.map(type => 
    `<label style="display: inline-block; margin-right: 10px; margin-bottom: 5px;">
      <input type="checkbox" class="type-filter" value="${type.chinese}" checked> 
      ${type.chinese} / ${type.english}
    </label>`
  ).join('');

  // 将后端常量转换为前端可用的JavaScript对象
  const currencySymbolsJson = JSON.stringify(CURRENCY_SYMBOLS);
  const currencyNamesJson = JSON.stringify(CURRENCY_NAMES);
  const expenseTypesJson = JSON.stringify(EXPENSE_TYPES);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>账单记录系统</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    .login-container, .app-container { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .hidden { display: none; }
    input, select, button { padding: 6px 10px; margin: 3px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
    button { background: #4CAF50; color: white; cursor: pointer; border: none; }
    button:hover { background: #45a049; }
    .logout-btn { background: #f44336; float: right; margin: 0; }
    .logout-btn:hover { background: #da190b; }
    table { width: 100%; border-collapse: collapse; margin-top: 5px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f2f2f2; cursor: pointer; }
    th:hover { background: #e0e0e0; }
    td:nth-child(5) { text-align: left; }
    .stats { display: flex; flex-wrap: wrap; gap: 15px; margin: 10px 0; }
    .stat-card { background: #e7f3ff; padding: 12px; border-radius: 8px; flex: 1 1 200px; text-align: center; }
    .stat-card h3 { margin: 0 0 8px; color: #333; font-size: 16px; }
    .stat-card .value { font-size: 22px; font-weight: bold; color: #2c3e50; }
    .stat-card.converted { background: #fff3e0; border: 2px solid #ff9800; }
    .stat-card.converted h3 { color: #e65100; }
    .error { color: red; margin: 10px 0; }
    .success { color: green; margin: 10px 0; }
    .form-row { display: flex; flex-wrap: wrap; align-items: center; background: #f9f9f9; padding: 10px; border-radius: 8px; margin-bottom: 10px; }
    .export-btn { background: #2196F3; }
    .export-btn:hover { background: #0b7dda; }
    .import-btn { background: #9C27B0; }
    .import-btn:hover { background: #7B1FA2; }
    .delete-btn { background: #ff9800; color: white; border: none; padding: 4px 8px; cursor: pointer; border-radius: 4px; font-size: 12px; }
    .delete-btn:hover { background: #e68900; }
    .filter-section { background: #f0f0f0; padding: 10px; border-radius: 8px; margin: 8px 0; }
    .date-filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .date-filter input[type="date"] { width: 130px; }
    .type-filter-section { margin: 5px 0; padding: 8px; background: #f9f9f9; border-radius: 4px; }
    .filter-title { font-weight: bold; margin-bottom: 5px; font-size: 14px; }
    .sort-indicator { font-size: 12px; margin-left: 5px; }
    .type-stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; text-align: left; font-size: 13px; }
    .type-stat-item { padding: 2px; }
    .batch-actions { margin: 5px 0; padding: 8px; background: #f0f0f0; border-radius: 4px; font-size: 14px; }
    .pagination { display: flex; justify-content: center; align-items: center; margin-top: 10px; gap: 5px; flex-wrap: wrap; }
    .pagination button { background: #f0f0f0; color: #333; min-width: 32px; padding: 5px 8px; margin: 0; }
    .pagination button.active { background: #4CAF50; color: white; }
    .pagination button:disabled { background: #ccc; cursor: not-allowed; }
    .pagination-info { margin: 0 8px; color: #666; font-size: 13px; }
    .page-size-select { margin-left: 8px; padding: 4px; border-radius: 4px; border: 1px solid #ddd; font-size: 13px; }
    .search-section { display: flex; align-items: center; gap: 5px; margin-left: auto; }
    .search-input { width: 180px; padding: 5px 8px; margin: 0; }
    .search-select { width: 65px; padding: 5px; margin: 0; font-size: 13px; }
    .clear-search { background: #f44336; padding: 5px 8px; margin: 0; }
    .clear-search:hover { background: #da190b; }
    .table-header { display: flex; justify-content: space-between; align-items: center; margin: 3px 0; }
    h2 { margin: 0 0 8px 0; font-size: 22px; }
    h3 { margin: 11px 0; font-size: 18px; }
    .app-container { padding: 15px; }
    #typeStats { max-height: 150px; overflow-y: auto; }
    .bill-select { margin: 0; width: 16px; height: 16px; }
    #selectAll { margin: 0; width: 16px; height: 16px; }
    .file-input { display: none; }
    .import-label { background: #9C27B0; color: white; padding: 5px 10px; border-radius: 4px; cursor: pointer; margin: 3px; display: inline-block; }
    .import-label:hover { background: #7B1FA2; }
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; }
    .modal-content { background: white; margin: 50px auto; padding: 20px; max-width: 500px; border-radius: 8px; max-height: 80vh; overflow-y: auto; }
    .modal-close { float: right; cursor: pointer; font-size: 20px; }
    .import-preview { max-height: 300px; overflow-y: auto; border: 1px solid #ddd; margin: 10px 0; }
    .import-preview table { font-size: 12px; }
    .import-preview td, .import-preview th { padding: 4px; }
    .duplicate-check { margin: 10px 0; padding: 10px; background: #fff3e0; border-radius: 4px; }
    .convert-btn { background: #ff9800; color: white; }
    .convert-btn:hover { background: #e68900; }
    .rate-info { font-size: 12px; color: #666; margin-top: 5px; }
    .converted-total { margin-top: 10px; padding: 10px; background: #e8f5e9; border-radius: 4px; text-align: center; }
    .converted-total h4 { margin: 0 0 5px 0; color: #2e7d32; }
    .converted-total .amount { font-size: 20px; font-weight: bold; color: #1b5e20; }
  </style>
</head>
<body>
  <div id="loginDiv" class="login-container">
    <h2>登录账单系统</h2>
    <div>
      <input type="password" id="passwordInput" placeholder="请输入密码" />
      <button onclick="login()">登录</button>
      <div id="loginError" class="error"></div>
    </div>
  </div>

  <div id="appDiv" class="app-container hidden">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
      <h2 style="margin: 0;">账单记录</h2>
      <button class="logout-btn" style="margin: 0;" onclick="logout()">退出登录</button>
    </div>

    <!-- 录入表单 -->
    <div class="form-row">
      <input type="date" id="billDate" style="margin: 2px;" />
      <input type="text" id="billName" placeholder="消费名称" style="margin: 2px;" />
      <select id="billType" style="margin: 2px;">
        ${typeOptionsHtml}
      </select>
      <select id="billCurrency" style="margin: 2px;">
        <option value="CNY">￥ 人民币/CNY</option>
        <option value="USD">$ 美金/USD</option>
        <option value="JPY">JP¥ 日元/JPY</option>
        <option value="KRW">₩ 韩币/KRW</option>
        <option value="HKD">HK$ 港币/HKD</option>
        <option value="TWD">NT$ 新台币/TWD</option>
        <option value="GBP">£ 英镑/GBP</option>
        <option value="EUR">€ 欧元/EUR</option>
        <option value="HUF">Ft 福林/HUF</option>
        <option value="SAR">SR 里亚尔/SAR</option>
        <option value="AED">AED 迪拉姆/AED</option>
      </select>
      <input type="number" id="billAmount" placeholder="消费金额" step="0.01" min="0" style="margin: 2px;" />
      <button onclick="addBill()" style="margin: 2px;">添加账单</button>
      <button class="export-btn" onclick="exportBills()" style="margin: 2px;">导出表格</button>
      <label class="import-label" onclick="document.getElementById('importFile').click()">导入表格</label>
      <input type="file" id="importFile" class="file-input" accept=".csv,text/csv" onchange="handleImportFile(this)" />
    </div>

    <!-- 统计卡片 -->
    <div class="stats">
      <div class="stat-card">
        <h3>当月总消费</h3>
        <div class="value" id="monthTotal">0.00</div>
      </div>
      <div class="stat-card">
        <h3>当年总消费</h3>
        <div class="value" id="yearTotal">0.00</div>
      </div>
      <div class="stat-card">
        <h3>类型统计</h3>
        <div id="typeStats" style="text-align: left;"></div>
      </div>
      <!-- 新增：汇率换算卡片 -->
      <div class="stat-card converted" id="convertedCard" style="display: none;">
        <h3>筛选结果换算</h3>
        <div class="converted-total">
          <div style="margin-bottom: 10px;">
            <h4>人民币总计 (CNY)</h4>
            <div class="amount" id="totalCNY">￥ 0.00</div>
          </div>
          <div>
            <h4>美金总计 (USD)</h4>
            <div class="amount" id="totalUSD">$ 0.00</div>
          </div>
        </div>
        <div class="rate-info" id="rateInfo"></div>
      </div>
    </div>

    <!-- 汇率换算按钮 -->
    <div style="margin: 10px 0; text-align: center;">
      <button class="convert-btn" onclick="convertCurrency()" id="convertBtn">
        🔄 换算当前筛选结果
      </button>
      <span id="convertStatus" style="margin-left: 10px; color: #666; font-size: 13px;"></span>
    </div>

    <!-- 筛选区域 -->
    <div class="filter-section">
      <div class="filter-title">日期筛选</div>
      <div class="date-filter">
        <input type="date" id="startDate" placeholder="开始日期" />
        <span style="margin: 0 5px;">至</span>
        <input type="date" id="endDate" placeholder="结束日期" />
        <button onclick="applyDateFilter()">应用筛选</button>
        <button onclick="clearDateFilter()">清除筛选</button>
      </div>
      
      <div class="filter-title" style="margin-top: 8px;">类型筛选</div>
      <div class="type-filter-section" id="typeFilterContainer">
        ${typeCheckboxesHtml}
      </div>
      <div style="margin-top: 5px;">
        <button onclick="selectAllTypes()">全选</button>
        <button onclick="deselectAllTypes()">取消全选</button>
      </div>
    </div>

    <!-- 批量操作区域 -->
    <div class="batch-actions">
      <button onclick="batchDeleteSelected()" style="background: #ff4444; padding: 5px 10px;">批量删除选中</button>
      <span style="margin-left: 10px; color: #666;">选中 <span id="selectedCount">0</span> 条记录</span>
    </div>

    <!-- 账单列表标题和搜索 -->
    <div class="table-header">
      <h3>历史账单 <span style="font-size: 13px; font-weight: normal;">(点击表头可排序)</span></h3>
      <div class="search-section">
        <select id="searchField" class="search-select">
          <option value="name">名称</option>
          <option value="amount">金额</option>
        </select>
        <input type="text" id="searchInput" class="search-input" placeholder="输入搜索关键词..." onkeyup="if(event.key==='Enter') searchBills()">
        <button onclick="searchBills()" style="padding: 5px 10px;">搜索</button>
        <button class="clear-search" onclick="clearSearch()" style="padding: 5px 10px;">清除</button>
      </div>
    </div>

    <table id="billsTable">
      <thead>
        <tr>
          <th style="width: 30px; text-align: center;"><input type="checkbox" id="selectAll" onclick="toggleAll()"></th>
          <th onclick="sortBills('date')">日期/Date <span id="sortIndicator" class="sort-indicator">↓</span></th>
          <th>名称</th>
          <th>类型/Type</th>
          <th>金额/Amount</th>
          <th style="width: 60px;">操作</th>
        </tr>
      </thead>
      <tbody id="billsBody"></tbody>
    </table>

    <!-- 分页控件 -->
    <div class="pagination">
      <button onclick="goToFirstPage()" id="firstPage" title="第一页">⟪</button>
      <button onclick="goToPrevPage()" id="prevPage" title="上一页">⟨</button>
      <span id="pageInfo" class="pagination-info"></span>
      <button onclick="goToNextPage()" id="nextPage" title="下一页">⟩</button>
      <button onclick="goToLastPage()" id="lastPage" title="最后一页">⟫</button>
      <select id="pageSize" class="page-size-select" onchange="changePageSize()">
        <option value="10">10条/页</option>
        <option value="20" selected>20条/页</option>
        <option value="50">50条/页</option>
        <option value="100">100条/页</option>
      </select>
    </div>
  </div>

  <!-- 导入预览弹窗 -->
  <div id="importModal" class="modal">
    <div class="modal-content">
      <span class="modal-close" onclick="closeImportModal()">&times;</span>
      <h3>导入账单预览</h3>
      <div class="duplicate-check">
        <label>
          <input type="checkbox" id="skipDuplicates" checked> 跳过重复记录（基于日期+名称+类型+币种+金额）
        </label>
      </div>
      <div id="importPreview" class="import-preview"></div>
      <div style="margin-top: 15px; text-align: right;">
        <button onclick="confirmImport()" style="background: #4CAF50;">确认导入</button>
        <button onclick="closeImportModal()" style="background: #f44336;">取消</button>
      </div>
    </div>
  </div>

  <script>
    // 从后端传递过来的常量
    const CURRENCY_SYMBOLS = ${currencySymbolsJson};
    const CURRENCY_NAMES = ${currencyNamesJson};
    const EXPENSE_TYPES = ${expenseTypesJson};

    // 当前排序状态 - 默认倒序（最新的在前面）
    let currentSort = { field: 'date', order: 'desc' };
    let currentStartDate = '';
    let currentEndDate = '';
    let selectedTypes = [];
    let selectedBillIds = new Set();
    
    // 分页相关变量
    let currentPage = 1;
    let pageSize = 20;
    let totalBills = [];
    let filteredBills = [];
    
    // 搜索相关变量
    let searchField = 'name';
    let searchKeyword = '';

    // 导入相关变量
    let importData = [];
    
    // 汇率缓存
    let exchangeRates = null;
    let ratesDate = null;

    // 设置默认日期
    document.getElementById('billDate').value = new Date().toISOString().slice(0,10);

    // 初始化所有类型为选中
    document.querySelectorAll('.type-filter').forEach(cb => {
      if (cb.checked) selectedTypes.push(cb.value);
    });

    // 检查本地存储的token
    const token = localStorage.getItem('token');
    if (token) {
      document.getElementById('loginDiv').classList.add('hidden');
      document.getElementById('appDiv').classList.remove('hidden');
      loadBills();
      loadStats();
    }

    async function login() {
      const password = document.getElementById('passwordInput').value;
      const loginError = document.getElementById('loginError');
      
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ password })
        });

        if (response.ok) {
          const data = await response.json();
          localStorage.setItem('token', data.token);
          document.getElementById('loginDiv').classList.add('hidden');
          document.getElementById('appDiv').classList.remove('hidden');
          loginError.innerText = '';
          loadBills();
          loadStats();
        } else {
          const errorText = await response.text();
          loginError.innerText = errorText || '密码错误';
        }
      } catch (error) {
        loginError.innerText = '登录失败：' + error.message;
      }
    }

    function logout() {
      localStorage.removeItem('token');
      location.reload();
    }

    function getHeaders() {
      const token = localStorage.getItem('token');
      return {
        'Content-Type': 'application/json',
        'Authorization': token ? 'Bearer ' + token : ''
      };
    }

    // 【核心修复】统一的请求处理函数：自动处理登录过期
    async function fetchWithAuth(url, options = {}) {
      // 合并 headers
      options.headers = { ...getHeaders(), ...options.headers };
      
      const response = await fetch(url, options);

      // 如果后台返回 401，说明登录已过期
      if (response.status === 401) {
        localStorage.removeItem('token'); // 清除过期凭证
        alert('⚠️ 登录已过期，请重新登录！'); // 弹窗提示
        location.reload(); // 刷新页面，自动跳回登录界面
        throw new Error('Login expired'); // 中断后续代码执行
      }

      return response;
    }

    // 获取汇率数据
    async function fetchExchangeRates() {
      try {
        const response = await fetch('/api/rates');
        if (!response.ok) throw new Error('获取汇率失败');
        
        const data = await response.json();
        exchangeRates = data.rates;
        ratesDate = data.date;
        return data;
      } catch (error) {
        console.error('获取汇率失败:', error);
        throw error;
      }
    }

    // 一键换算汇率 - 增加筛选参数
    async function convertCurrency() {
      const btn = document.getElementById('convertBtn');
      const status = document.getElementById('convertStatus');
      const card = document.getElementById('convertedCard');
      
      try {
        btn.disabled = true;
        btn.innerText = '⏳ 获取汇率中...';
        status.innerText = '';
        
        // 获取汇率
        const ratesData = await fetchExchangeRates();
        
        btn.innerText = '⏳ 计算中...';
        
        // 发送当前筛选条件到后端进行计算
        const response = await fetchWithAuth('/api/stats', {
          method: 'POST',
          body: JSON.stringify({
            startDate: currentStartDate,
            endDate: currentEndDate,
            types: selectedTypes,
            convertTo: 'CNY,USD',
            rates: exchangeRates
          })
        });
        
        if (!response.ok) throw new Error('统计失败');
        
        const stats = await response.json();
        
        // 显示换算结果
        if (stats.converted) {
          document.getElementById('totalCNY').innerText = '￥ ' + (stats.converted.CNY || 0).toFixed(2);
          document.getElementById('totalUSD').innerText = '$ ' + (stats.converted.USD || 0).toFixed(2);
          
          let rateInfo = '汇率日期: ' + ratesDate;
          if (ratesData.isFallback) {
            rateInfo += ' (使用备用汇率)';
          }
          
          // 显示筛选范围提示
          let filterDesc = '';
          if (currentStartDate || currentEndDate) {
            filterDesc = ' (' + (currentStartDate || '始') + ' 至 ' + (currentEndDate || '今') + ')';
          }
          if (selectedTypes && selectedTypes.length < EXPENSE_TYPES.length) {
            filterDesc += ' [已选类型]';
          }
          
          document.getElementById('rateInfo').innerText = rateInfo + filterDesc;
          
          card.style.display = 'block';
          status.innerText = '✅ 换算完成';
          status.style.color = 'green';
        }
        
      } catch (error) {
        status.innerText = '❌ 换算失败: ' + error.message;
        status.style.color = 'red';
      } finally {
        btn.disabled = false;
        btn.innerText = '🔄 换算当前筛选结果';
      }
    }

    async function addBill() {
      const date = document.getElementById('billDate').value;
      const name = document.getElementById('billName').value.trim();
      const type = document.getElementById('billType').value;
      const currency = document.getElementById('billCurrency').value;
      const amount = parseFloat(document.getElementById('billAmount').value);

      if (!date || !name || !type || !currency || isNaN(amount) || amount <= 0) {
        alert('请完整填写所有字段');
        return;
      }

      try {
        const response = await fetchWithAuth('/api/bills', {
          method: 'POST',
          body: JSON.stringify({ date, name, type, currency, amount })
        });

        if (response.ok) {
          document.getElementById('billName').value = '';
          document.getElementById('billAmount').value = '';
          // 隐藏换算结果，因为数据已更新
          document.getElementById('convertedCard').style.display = 'none';
          await loadBills();
          await loadStats();
        } else {
          alert('添加失败');
        }
      } catch (error) {
        console.error('Add bill error:', error);
      }
    }

    function sortBills(field) {
      if (currentSort.field === field) {
        currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.field = field;
        currentSort.order = 'desc';
      }
      
      const indicator = document.getElementById('sortIndicator');
      indicator.innerText = currentSort.order === 'asc' ? '↑' : '↓';
      
      applyFiltersAndSort();
    }

    function applyDateFilter() {
      currentStartDate = document.getElementById('startDate').value;
      currentEndDate = document.getElementById('endDate').value;
      currentPage = 1;
      applyFiltersAndSort();
      loadStats();
      // 筛选改变时隐藏换算结果
      document.getElementById('convertedCard').style.display = 'none';
    }

    function clearDateFilter() {
      document.getElementById('startDate').value = '';
      document.getElementById('endDate').value = '';
      currentStartDate = '';
      currentEndDate = '';
      currentPage = 1;
      applyFiltersAndSort();
      loadStats();
      document.getElementById('convertedCard').style.display = 'none';
    }

    function updateSelectedTypes() {
      selectedTypes = [];
      document.querySelectorAll('.type-filter:checked').forEach(cb => {
        selectedTypes.push(cb.value);
      });
      currentPage = 1;
      applyFiltersAndSort();
      document.getElementById('convertedCard').style.display = 'none';
    }

    function selectAllTypes() {
      document.querySelectorAll('.type-filter').forEach(cb => {
        cb.checked = true;
      });
      updateSelectedTypes();
    }

    function deselectAllTypes() {
      document.querySelectorAll('.type-filter').forEach(cb => {
        cb.checked = false;
      });
      updateSelectedTypes();
    }

    document.querySelectorAll('.type-filter').forEach(cb => {
      cb.addEventListener('change', updateSelectedTypes);
    });

    // 搜索相关函数
    function searchBills() {
      searchField = document.getElementById('searchField').value;
      searchKeyword = document.getElementById('searchInput').value.trim().toLowerCase();
      currentPage = 1;
      applyFiltersAndSort();
    }

    function clearSearch() {
      document.getElementById('searchInput').value = '';
      searchKeyword = '';
      currentPage = 1;
      applyFiltersAndSort();
    }

    function toggleAll() {
      const selectAll = document.getElementById('selectAll');
      const checkboxes = document.querySelectorAll('.bill-select');
      
      if (selectAll.checked) {
        checkboxes.forEach(cb => {
          cb.checked = true;
          selectedBillIds.add(cb.value);
        });
      } else {
        checkboxes.forEach(cb => {
          cb.checked = false;
          selectedBillIds.delete(cb.value);
        });
      }
      
      updateSelectedCount();
    }

    function toggleSelect(id, checked) {
      if (checked) {
        selectedBillIds.add(id);
      } else {
        selectedBillIds.delete(id);
        document.getElementById('selectAll').checked = false;
      }
      updateSelectedCount();
    }

    function updateSelectedCount() {
      document.getElementById('selectedCount').innerText = selectedBillIds.size;
    }

    async function batchDeleteSelected() {
      if (selectedBillIds.size === 0) {
        alert('请先选择要删除的账单');
        return;
      }
      
      if (!confirm('确定删除选中的 ' + selectedBillIds.size + ' 条账单？')) return;
      
      try {
        const response = await fetchWithAuth('/api/bills/batch', {
          method: 'POST',
          body: JSON.stringify({
            operation: 'delete',
            ids: Array.from(selectedBillIds)
          })
        });

        if (response.ok) {
          selectedBillIds.clear();
          document.getElementById('selectAll').checked = false;
          document.getElementById('convertedCard').style.display = 'none';
          await loadBills();
          await loadStats();
          updateSelectedCount();
        } else {
          alert('批量删除失败');
        }
      } catch (error) {
        console.error('Batch delete error:', error);
      }
    }

    function changePageSize() {
      pageSize = parseInt(document.getElementById('pageSize').value);
      currentPage = 1;
      renderCurrentPage();
    }

    function goToFirstPage() {
      if (currentPage > 1) {
        currentPage = 1;
        renderCurrentPage();
      }
    }

    function goToPrevPage() {
      if (currentPage > 1) {
        currentPage--;
        renderCurrentPage();
      }
    }

    function goToNextPage() {
      const totalPages = Math.ceil(filteredBills.length / pageSize);
      if (currentPage < totalPages) {
        currentPage++;
        renderCurrentPage();
      }
    }

    function goToLastPage() {
      const totalPages = Math.ceil(filteredBills.length / pageSize);
      if (currentPage < totalPages) {
        currentPage = totalPages;
        renderCurrentPage();
      }
    }

    function applyFiltersAndSort() {
      if (!totalBills || totalBills.length === 0) {
        filteredBills = [];
        renderCurrentPage();
        return;
      }
      
      let filtered = [...totalBills];
      
      if (currentStartDate || currentEndDate) {
        filtered = filtered.filter(bill => {
          if (currentStartDate && bill.date < currentStartDate) return false;
          if (currentEndDate && bill.date > currentEndDate) return false;
          return true;
        });
      }
      
      if (selectedTypes && selectedTypes.length > 0) {
        filtered = filtered.filter(bill => selectedTypes.includes(bill.type));
      }
      
      if (searchKeyword) {
        filtered = filtered.filter(bill => {
          if (searchField === 'name') {
            return bill.name.toLowerCase().includes(searchKeyword);
          } else if (searchField === 'amount') {
            const amountStr = bill.amount.toString();
            
            if (searchKeyword.includes('-')) {
              const [min, max] = searchKeyword.split('-').map(Number);
              if (!isNaN(min) && !isNaN(max)) {
                return bill.amount >= min && bill.amount <= max;
              }
            } else if (searchKeyword.startsWith('>')) {
              const num = parseFloat(searchKeyword.substring(1));
              if (!isNaN(num)) {
                return bill.amount > num;
              }
            } else if (searchKeyword.startsWith('<')) {
              const num = parseFloat(searchKeyword.substring(1));
              if (!isNaN(num)) {
                return bill.amount < num;
              }
            } else {
              const num = parseFloat(searchKeyword);
              if (!isNaN(num)) {
                return bill.amount === num || amountStr.includes(searchKeyword);
              }
              return amountStr.includes(searchKeyword);
            }
          }
          return false;
        });
      }
      
      filtered.sort((a, b) => {
        if (currentSort.field === 'date') {
          const dateA = new Date(a.date);
          const dateB = new Date(b.date);
          return currentSort.order === 'asc' ? dateA - dateB : dateB - dateA;
        }
        return 0;
      });
      
      filteredBills = filtered;
      currentPage = 1;
      renderCurrentPage();
    }

    function renderCurrentPage() {
      const tbody = document.getElementById('billsBody');
      tbody.innerHTML = '';
      
      if (!filteredBills || filteredBills.length === 0) {
        // 显示空状态
        const row = tbody.insertRow();
        const cell = row.insertCell(0);
        cell.colSpan = 6;
        cell.style.textAlign = 'center';
        cell.style.padding = '20px';
        cell.innerText = '暂无账单数据';
        updatePaginationInfo();
        return;
      }
      
      const startIndex = (currentPage - 1) * pageSize;
      const endIndex = Math.min(startIndex + pageSize, filteredBills.length);
      const pageBills = filteredBills.slice(startIndex, endIndex);
      
      const currencySymbols = {
        'CNY': '￥', 'USD': '$', 'JPY': 'JP¥', 'KRW': '₩', 'AED': 'AED ',
        'TWD': 'NT$', 'HKD': 'HK$', 'GBP': '£', 'EUR': '€', 'HUF': 'Ft ', 'SAR': 'SR '
      };
      
      const typeMap = {
        '餐饮': 'Food', '购物': 'Shopping', '交通': 'Transport', '住宿': 'Accommodation',
        '通信': 'Communication', '停车': 'Parking', '娱乐': 'Entertainment', '其他': 'Other'
      };
      
      pageBills.forEach(bill => {
        const row = tbody.insertRow();
        const symbol = currencySymbols[bill.currency] || '';
        const typeEnglish = typeMap[bill.type] || bill.type;
        const amountDisplay = symbol + bill.amount.toFixed(2);
        const checked = selectedBillIds.has(bill.id) ? 'checked' : '';
        
        row.innerHTML = \`
          <td style="text-align: center;"><input type="checkbox" class="bill-select" value="\${bill.id}" \${checked} onchange="toggleSelect('\${bill.id}', this.checked)"></td>
          <td>\${bill.date}</td>
          <td>\${bill.name}</td>
          <td>\${bill.type} / \${typeEnglish}</td>
          <td>\${amountDisplay}</td>
          <td><button class="delete-btn" onclick="deleteBill('\${bill.id}')">删除</button></td>
        \`;
      });
      
      const totalCheckboxes = document.querySelectorAll('.bill-select').length;
      const checkedCheckboxes = document.querySelectorAll('.bill-select:checked').length;
      document.getElementById('selectAll').checked = totalCheckboxes > 0 && totalCheckboxes === checkedCheckboxes;
      
      updatePaginationInfo();
      
      const oldInfo = document.getElementById('searchInfo');
      if (oldInfo) oldInfo.remove();
      
      if (searchKeyword) {
        const searchInfo = document.createElement('div');
        searchInfo.style.marginTop = '8px';
        searchInfo.style.color = '#666';
        searchInfo.style.fontSize = '13px';
        searchInfo.innerText = \`找到 \${filteredBills.length} 条匹配的记录\`;
        searchInfo.id = 'searchInfo';
        document.querySelector('.pagination').before(searchInfo);
      }
    }

    function updatePaginationInfo() {
      const totalItems = filteredBills ? filteredBills.length : 0;
      const totalPages = Math.ceil(totalItems / pageSize);
      document.getElementById('pageInfo').innerText = \`第 \${currentPage}/\${totalPages} 页，共 \${totalItems} 条\`;
      
      document.getElementById('firstPage').disabled = currentPage === 1 || totalItems === 0;
      document.getElementById('prevPage').disabled = currentPage === 1 || totalItems === 0;
      document.getElementById('nextPage').disabled = currentPage === totalPages || totalPages === 0;
      document.getElementById('lastPage').disabled = currentPage === totalPages || totalPages === 0;
    }

    async function loadBills() {
      try {
        const response = await fetchWithAuth('/api/bills');
        if (!response.ok) throw new Error('加载失败');
        
        const data = await response.json();
        
        // 确保数据是数组
        totalBills = Array.isArray(data) ? data : [];
        applyFiltersAndSort();
      } catch (error) {
        console.error('Load bills error:', error);
        totalBills = [];
        filteredBills = [];
        renderCurrentPage();
      }
    }

    async function deleteBill(id) {
      if (!confirm('确定删除该账单？')) return;

      try {
        const response = await fetchWithAuth('/api/bills?id=' + id, {
          method: 'DELETE'
        });

        if (response.ok) {
          selectedBillIds.delete(id);
          document.getElementById('convertedCard').style.display = 'none';
          await loadBills();
          await loadStats();
          updateSelectedCount();
        } else {
          alert('删除失败');
        }
      } catch (error) {
        console.error('Delete bill error:', error);
      }
    }

    async function loadStats() {
      try {
        const response = await fetchWithAuth('/api/stats', {
          method: 'POST',
          body: JSON.stringify({
            startDate: currentStartDate,
            endDate: currentEndDate,
            types: selectedTypes
          })
        });
        
        if (!response.ok) throw new Error('加载统计失败');
        
        const stats = await response.json();
        
        const currencySymbols = {
          'CNY': '￥', 'USD': '$', 'JPY': 'JP¥', 'KRW': '₩', 'AED': 'AED ',
          'TWD': 'NT$', 'HKD': 'HK$', 'GBP': '£', 'EUR': '€', 'HUF': 'Ft ', 'SAR': 'SR '
        };
        
        document.getElementById('monthTotal').innerText = (stats.monthTotal || 0).toFixed(2);
        document.getElementById('yearTotal').innerText = (stats.yearTotal || 0).toFixed(2);
        
        let typeHtml = '<div class="type-stats-grid">';
        
        if (stats.typeDetails && Object.keys(stats.typeDetails).length > 0) {
          for (const [type, data] of Object.entries(stats.typeDetails)) {
            typeHtml += '<div class="type-stat-item"><strong>' + type + ':</strong><br>';
            
            for (const [currency, total] of Object.entries(data)) {
              const symbol = currencySymbols[currency] || currency;
              typeHtml += '<span style="font-size: 11px;">' + symbol + ' ' + total.toFixed(2) + '</span><br>';
            }
            typeHtml += '</div>';
          }
        } else {
          typeHtml += '<div style="font-size: 12px;">暂无数据</div>';
        }
        
        typeHtml += '</div>';
        document.getElementById('typeStats').innerHTML = typeHtml;
      } catch (error) {
        console.error('Load stats error:', error);
      }
    }

    async function exportBills() {
      try {
        const response = await fetchWithAuth('/api/bills/export', {
          method: 'POST',
          body: JSON.stringify({
            startDate: currentStartDate,
            endDate: currentEndDate,
            types: selectedTypes
          })
        });
        
        if (!response.ok) throw new Error('导出失败');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '账单导出_' + new Date().toISOString().slice(0,10) + '.csv';
        a.click();
        window.URL.revokeObjectURL(url);
      } catch (error) {
        console.error('Export error:', error);
      }
    }

    // 导入功能
    function handleImportFile(input) {
      const file = input.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = function(e) {
        const content = e.target.result;
        parseImportContent(content);
      };
      reader.readAsText(file, 'UTF-8');
      
      // 清空input，允许重复选择同一个文件
      input.value = '';
    }

    function parseImportContent(content) {
      try {
        const lines = content.split('\\n');
        if (lines.length < 2) {
          alert('文件内容为空');
          return;
        }
        
        // 检查BOM头并移除
        if (lines[0].charCodeAt(0) === 0xFEFF) {
          lines[0] = lines[0].slice(1);
        }
        
        const headers = lines[0].split(',');
        if (headers.length < 5) {
          alert('无效的CSV格式，请使用导出的表格格式');
          return;
        }
        
        importData = [];
        const errors = [];
        
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          // 处理CSV中的引号
          const fields = parseCSVLine(line);
          if (fields.length < 5) continue;
          
          let date = fields[0].trim();
          date = date.replace(/^[\\u200B-\\u200D\\uFEFF]+/g, '');
          
          let typeDisplay = fields[1].replace(/^"|"$/g, '').replace(/""/g, '"');
          let name = fields[2].replace(/^"|"$/g, '').replace(/""/g, '"');
          let currencyName = fields[3].replace(/^"|"$/g, '').replace(/""/g, '"');
          let amountDisplay = fields[4].replace(/^"|"$/g, '').replace(/""/g, '"');
          
          let type = typeDisplay.split('/')[0].trim();
          
          let currency = 'CNY';
          for (const [code, name] of Object.entries({
            'CNY': '人民币/CNY', 'USD': '美金/USD', 'JPY': '日元/JPY', 'KRW': '韩币/KRW',
            'AED': '迪拉姆/AED', 'TWD': '新台币/TWD', 'HKD': '港币/HKD', 'GBP': '英镑/GBP',
            'EUR': '欧元/EUR', 'HUF': '福林/HUF', 'SAR': '里亚尔/SAR'
          })) {
            if (currencyName.includes(name) || currencyName.includes(code)) {
              currency = code;
              break;
            }
          }
          
          let amount = parseFloat(amountDisplay.replace(/[^0-9.-]/g, ''));
          
          if (!date || !name || !type || !currency || isNaN(amount) || amount <= 0) {
            errors.push('第' + (i+1) + '行数据格式错误：' + line);
            continue;
          }
          
          const dateRegex = /^\\d{4}[-/]\\d{2}[-/]\\d{2}$/;
          if (!dateRegex.test(date)) {
            errors.push('第' + (i+1) + '行日期格式错误，应为YYYY-MM-DD，实际为: ' + date);
            continue;
          }
          
          date = date.replace(/\\//g, '-');
          
          importData.push({
            date,
            name,
            type,
            currency,
            amount
          });
        }
        
        if (importData.length === 0) {
          alert('没有有效的账单数据可导入\\n' + errors.join('\\n'));
          return;
        }
        
        showImportPreview(importData, errors);
      } catch (error) {
        alert('解析文件失败：' + error.message);
      }
    }

    function parseCSVLine(line) {
      const fields = [];
      let field = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
          if (inQuotes && line[i+1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          fields.push(field);
          field = '';
        } else {
          field += char;
        }
      }
      
      fields.push(field);
      return fields;
    }

    function showImportPreview(data, errors) {
      const previewDiv = document.getElementById('importPreview');
      let html = '<table><tr><th>日期</th><th>类型</th><th>名称</th><th>币种</th><th>金额</th></tr>';
      
      data.slice(0, 20).forEach(item => {
        const symbol = CURRENCY_SYMBOLS[item.currency] || '';
        html += \`<tr>
          <td>\${item.date}</td>
          <td>\${item.type}</td>
          <td>\${item.name}</td>
          <td>\${item.currency}</td>
          <td>\${symbol}\${item.amount.toFixed(2)}</td>
        </tr>\`;
      });
      
      if (data.length > 20) {
        html += \`<tr><td colspan="5" style="text-align: center;">... 共 \${data.length} 条记录，仅显示前20条</td></tr>\`;
      }
      
      html += '</table>';
      
      if (errors.length > 0) {
        html += '<div style="color: orange; margin-top: 10px;">解析错误：<br>' + errors.slice(0, 5).join('<br>') + '</div>';
      }
      
      previewDiv.innerHTML = html;
      document.getElementById('importModal').style.display = 'block';
    }

    function closeImportModal() {
      document.getElementById('importModal').style.display = 'none';
      importData = [];
    }

    async function confirmImport() {
      const skipDuplicates = document.getElementById('skipDuplicates').checked;
      
      try {
        const response = await fetchWithAuth('/api/bills/import', {
          method: 'POST',
          body: JSON.stringify({
            bills: importData,
            skipDuplicates: skipDuplicates
          })
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(error);
        }
        
        const result = await response.json();
        alert(\`导入成功！新增 \${result.added} 条记录，跳过 \${result.skipped} 条重复记录\`);
        
        closeImportModal();
        document.getElementById('convertedCard').style.display = 'none';
        await loadBills();
        await loadStats();
      } catch (error) {
        alert('导入失败：' + error.message);
      }
    }

    document.getElementById('passwordInput').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') login();
    });
  </script>
</body>
</html>`;
  
  return new Response(html, {
    headers: { "Content-Type": "text/html", ...CORS_HEADERS() }
  });
}

// 处理登录
async function handleLogin(request) {
  try {
    const { password } = await request.json();
    
    if (password === VALID_PASSWORD) {
      const token = btoa(USERNAME + ":" + Date.now());
      return new Response(JSON.stringify({ success: true, token }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS() }
      });
    } else {
      return new Response("密码错误", { status: 401, headers: CORS_HEADERS() });
    }
  } catch (error) {
    return new Response("无效请求", { status: 400, headers: CORS_HEADERS() });
  }
}

// 检查认证
function checkAuth(request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { passed: false, response: new Response("未授权", { status: 401, headers: CORS_HEADERS() }) };
  }
  
  const token = authHeader.slice(7);
  try {
    const decoded = atob(token);
    const [username, timestamp] = decoded.split(":");
    if (username === USERNAME && timestamp && (Date.now() - parseInt(timestamp) < 86400000)) {
      return { passed: true };
    }
  } catch (error) {}
  
  return { passed: false, response: new Response("令牌无效或过期", { status: 401, headers: CORS_HEADERS() }) };
}

function getBillsKey(year) {
  return `bills_${year}`;
}

async function getAllBills(env, forceRefresh = false) {
  try {
    const now = Date.now();
    
    if (!forceRefresh && billsCache._all && billsCache._all.length > 0 && (now - cacheTimestamp) < CACHE_TTL) {
      return billsCache._all;
    }
    
    const yearList = await env.BILL_KV.get("bills_years", "json") || [];
    
    if (yearList.length === 0) {
      billsCache._all = [];
      cacheTimestamp = now;
      return [];
    }
    
    const promises = yearList.map(year => 
      env.BILL_KV.get(getBillsKey(year), "json").then(bills => {
        if (bills && typeof bills === 'object' && !Array.isArray(bills) && bills.bills) {
           return bills.bills;
        }
        return Array.isArray(bills) ? bills : [];
      })
    );
    
    const yearBillsArray = await Promise.all(promises);
    
    const allBills = yearBillsArray.flat();
    
    billsCache._all = allBills;
    yearBillsArray.forEach((bills, index) => {
      billsCache[yearList[index]] = bills;
    });
    cacheTimestamp = now;
    
    return allBills;
  } catch (error) {
    console.error('Error reading from KV:', error);
    return [];
  }
}

async function getYearBills(env, year, forceRefresh = false) {
  try {
    const now = Date.now();
    const cacheKey = year.toString();
    
    if (!forceRefresh && billsCache[cacheKey] && (now - cacheTimestamp) < CACHE_TTL) {
      return billsCache[cacheKey];
    }
    
    let bills = await env.BILL_KV.get(getBillsKey(year), "json") || [];
    
    if (bills && typeof bills === 'object' && !Array.isArray(bills) && bills.bills) {
       bills = bills.bills;
    }
    
    const billsArray = Array.isArray(bills) ? bills : [];
    
    billsCache[cacheKey] = billsArray;
    cacheTimestamp = now;
    
    return billsArray;
  } catch (error) {
    console.error(`Error reading year ${year} from KV:`, error);
    return [];
  }
}

async function saveYearBills(env, year, bills) {
  try {
    const key = getBillsKey(year);
    
    const billsArray = Array.isArray(bills) ? bills : [];
    
    if (billsArray.length === 0) {
      await env.BILL_KV.delete(key);
      
      const yearList = await env.BILL_KV.get("bills_years", "json") || [];
      const newYearList = yearList.filter(y => y !== year.toString());
      if (newYearList.length > 0) {
        await env.BILL_KV.put("bills_years", JSON.stringify(newYearList));
      } else {
        await env.BILL_KV.delete("bills_years");
      }
    } else {
      await env.BILL_KV.put(key, JSON.stringify(billsArray));
      
      const yearList = await env.BILL_KV.get("bills_years", "json") || [];
      if (!yearList.includes(year.toString())) {
        yearList.push(year.toString());
        yearList.sort();
        await env.BILL_KV.put("bills_years", JSON.stringify(yearList));
      }
    }
    
    billsCache[year] = billsArray;
    cacheTimestamp = Date.now();
    return true;
  } catch (error) {
    console.error(`Error writing year ${year} to KV:`, error);
    throw error;
  }
}

async function batchBills(request, env) {
  try {
    const { operation, ids } = await request.json();
    
    if (operation === 'delete') {
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return new Response("无效的批量删除请求", { status: 400, headers: CORS_HEADERS() });
      }
      
      const allBills = await getAllBills(env, true);
      const idSet = new Set(ids);
      
      const billsToDelete = allBills.filter(b => idSet.has(b.id));
      const billsByYear = {};
      
      billsToDelete.forEach(bill => {
        const year = bill.date.split('-')[0];
        if (!billsByYear[year]) {
          billsByYear[year] = [];
        }
        billsByYear[year].push(bill.id);
      });
      
      let deletedCount = 0;
      for (const [year, yearIds] of Object.entries(billsByYear)) {
        const yearSet = new Set(yearIds);
        const yearBills = await getYearBills(env, year, true);
        const newYearBills = yearBills.filter(b => !yearSet.has(b.id));
        
        if (newYearBills.length !== yearBills.length) {
          await saveYearBills(env, year, newYearBills);
          deletedCount += yearBills.length - newYearBills.length;
        }
      }
      
      if (deletedCount === 0) {
        return new Response("未找到要删除的账单", { status: 404, headers: CORS_HEADERS() });
      }
      
      return new Response(JSON.stringify({ 
        success: true, 
        deleted: deletedCount 
      }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS() }
      });
    }
    
    return new Response("不支持的批量操作", { status: 400, headers: CORS_HEADERS() });
  } catch (error) {
    return new Response("批量操作失败", { status: 500, headers: CORS_HEADERS() });
  }
}

async function getBills(env) {
  const bills = await getAllBills(env, true);
  const billsArray = Array.isArray(bills) ? bills : [];
  return new Response(JSON.stringify(billsArray), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS() }
  });
}

async function addBill(request, env) {
  try {
    const { date, name, type, currency, amount } = await request.json();
    
    if (!date || !name || !type || !currency || amount === undefined) {
      return new Response("缺少必要字段", { status: 400, headers: CORS_HEADERS() });
    }
    
    const year = date.split('-')[0];
    
    const newBill = {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36),
      date,
      name,
      type,
      currency,
      amount: parseFloat(amount)
    };
    
    const yearBills = await getYearBills(env, year, true);
    yearBills.push(newBill);
    
    await saveYearBills(env, year, yearBills);
    
    return new Response(JSON.stringify(newBill), { 
      status: 201, 
      headers: { "Content-Type": "application/json", ...CORS_HEADERS() } 
    });
  } catch (error) {
    return new Response("添加失败", { status: 500, headers: CORS_HEADERS() });
  }
}

async function deleteBill(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  
  if (!id) {
    return new Response("缺少ID", { status: 400, headers: CORS_HEADERS() });
  }
  
  const allBills = await getAllBills(env, true);
  const billToDelete = allBills.find(b => b.id === id);
  
  if (!billToDelete) {
    return new Response("账单不存在", { status: 404, headers: CORS_HEADERS() });
  }
  
  const year = billToDelete.date.split('-')[0];
  
  const yearBills = await getYearBills(env, year, true);
  const newYearBills = yearBills.filter(b => b.id !== id);
  
  await saveYearBills(env, year, newYearBills);
  
  return new Response("删除成功", { status: 200, headers: CORS_HEADERS() });
}

// 统计功能（支持筛选，增加汇率换算）
async function getStats(request, env) {
  try {
    const { startDate, endDate, types, convertTo, rates } = await request.json();
    const bills = await getAllBills(env, true);
    
    let filteredBills = Array.isArray(bills) ? bills : [];
    if (startDate || endDate) {
      filteredBills = filteredBills.filter(bill => {
        if (startDate && bill.date < startDate) return false;
        if (endDate && bill.date > endDate) return false;
        return true;
      });
    }
    
    if (types && types.length > 0) {
      filteredBills = filteredBills.filter(bill => types.includes(bill.type));
    }
    
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    let monthTotal = 0;
    let yearTotal = 0;
    let typeDetails = {};

    filteredBills.forEach(b => {
      const [y, m] = b.date.split("-").map(Number);
      
      if (y === currentYear && m === currentMonth) {
        monthTotal += b.amount;
      }
      
      if (y === currentYear) {
        yearTotal += b.amount;
      }
      
      if (!typeDetails[b.type]) {
        typeDetails[b.type] = {};
      }
      if (!typeDetails[b.type][b.currency]) {
        typeDetails[b.type][b.currency] = 0;
      }
      typeDetails[b.type][b.currency] += b.amount;
    });

    const response = { monthTotal, yearTotal, typeDetails };

    // 如果请求包含汇率换算参数
    if (convertTo && rates) {
      const converted = {};
      
      const targetCurrencies = convertTo.split(',').map(c => c.trim());
      targetCurrencies.forEach(currency => {
        converted[currency] = 0;
      });

      // 【核心修复】严谨的汇率换算逻辑
      // 确保 rates 是基于 USD 的汇率 (即 rates.USD = 1)
      // 公式：金额(USD) = 金额(原币) / 汇率(原币)
      // 金额(目标币) = 金额(USD) * 汇率(目标币)
      
      const usdRate = rates['USD'] || 1;
      
      filteredBills.forEach(b => {
        const sourceRate = rates[b.currency];
        
        if (sourceRate && sourceRate !== 0) {
          // 1. 先将原币转换为 USD
          // 如果 rates 是标准的以USD为基准，那么 sourceRate 代表 1 USD = x Currency
          // 所以 1 Currency = 1/x USD
          const amountInUSD = b.amount / sourceRate;
          
          // 2. 将 USD 转换为目标币种
          targetCurrencies.forEach(targetCurrency => {
            const targetRate = rates[targetCurrency];
            if (targetRate) {
              const amountInTarget = amountInUSD * targetRate;
              converted[targetCurrency] += amountInTarget;
            }
          });
        }
      });
      
      response.converted = converted;
    }

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS() }
    });
  } catch (error) {
    return new Response("统计失败", { status: 500, headers: CORS_HEADERS() });
  }
}

// 导出CSV表格（支持筛选）
async function exportBills(request, env) {
  try {
    const { startDate, endDate, types } = await request.json();
    const bills = await getAllBills(env, true);
    
    let filteredBills = Array.isArray(bills) ? bills : [];
    if (startDate || endDate) {
      filteredBills = filteredBills.filter(bill => {
        if (startDate && bill.date < startDate) return false;
        if (endDate && bill.date > endDate) return false;
        return true;
      });
    }
    
    if (types && types.length > 0) {
      filteredBills = filteredBills.filter(bill => types.includes(bill.type));
    }
    
    filteredBills.sort((a, b) => a.date.localeCompare(b.date));
    
    const currencySymbols = {
      'CNY': '￥', 'USD': '$', 'JPY': 'JP¥', 'KRW': '₩', 'AED': 'AED ',
      'TWD': 'NT$', 'HKD': 'HK$', 'GBP': '£', 'EUR': '€', 'HUF': 'Ft ', 'SAR': 'SR '
    };
    
    const currencyNames = {
      'CNY': '人民币/CNY', 'USD': '美金/USD', 'JPY': '日元/JPY', 'KRW': '韩币/KRW',
      'AED': '迪拉姆/AED', 'TWD': '新台币/TWD', 'HKD': '港币/HKD', 'GBP': '英镑/GBP',
      'EUR': '欧元/EUR', 'HUF': '福林/HUF', 'SAR': '里亚尔/SAR'
    };
    
    const typeMap = {
      '餐饮': 'Food', '购物': 'Shopping', '交通': 'Transport', '住宿': 'Accommodation',
      '通信': 'Communication', '停车': 'Parking', '娱乐': 'Entertainment', '其他': 'Other'
    };
    
    let csv = "\uFEFF日期/Date,消费类型/Type,消费名称/Name,币种/Currency,金额/Amount\n";
    
    filteredBills.forEach(b => {
      const symbol = currencySymbols[b.currency] || b.currency;
      const currencyName = currencyNames[b.currency] || b.currency;
      const typeEnglish = typeMap[b.type] || b.type;
      const typeDisplay = b.type + "/" + typeEnglish;
      const amountDisplay = symbol + b.amount.toFixed(2);
      
      csv = csv + b.date + "," +
            '"' + typeDisplay.replace(/"/g, '""') + '",' +
            '"' + b.name.replace(/"/g, '""') + '",' +
            '"' + currencyName.replace(/"/g, '""') + '",' +
            '"' + amountDisplay.replace(/"/g, '""') + '"\n';
    });
    
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=bills_" + new Date().toISOString().slice(0,10) + ".csv",
        ...CORS_HEADERS()
      }
    });
  } catch (error) {
    return new Response("导出失败", { status: 500, headers: CORS_HEADERS() });
  }
}

// 导入账单
async function importBills(request, env) {
  try {
    const { bills, skipDuplicates = true } = await request.json();
    
    if (!bills || !Array.isArray(bills) || bills.length === 0) {
      return new Response("没有可导入的数据", { status: 400, headers: CORS_HEADERS() });
    }
    
    const billsByYear = {};
    const validBills = [];
    const skipped = [];
    
    const existingBills = await getAllBills(env, true);
    
    for (const bill of bills) {
      if (!bill.date || !bill.name || !bill.type || !bill.currency || bill.amount === undefined) {
        skipped.push(bill);
        continue;
      }
      
      const amount = parseFloat(bill.amount);
      if (isNaN(amount) || amount <= 0) {
        skipped.push(bill);
        continue;
      }
      
      const dateRegex = /^\\d{4}-\\d{2}-\\d{2}$/;
      if (!dateRegex.test(bill.date)) {
        skipped.push(bill);
        continue;
      }
      
      const year = bill.date.split('-')[0];
      
      const newBill = {
        id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36),
        date: bill.date,
        name: bill.name.trim(),
        type: bill.type,
        currency: bill.currency,
        amount: amount
      };
      
      if (skipDuplicates) {
        const isDuplicate = existingBills.some(existing => 
          existing.date === newBill.date &&
          existing.name === newBill.name &&
          existing.type === newBill.type &&
          existing.currency === newBill.currency &&
          Math.abs(existing.amount - newBill.amount) < 0.01
        );
        
        if (isDuplicate) {
          skipped.push(newBill);
          continue;
        }
      }
      
      if (!billsByYear[year]) {
        billsByYear[year] = [];
      }
      billsByYear[year].push(newBill);
      validBills.push(newBill);
    }
    
    let added = 0;
    for (const [year, yearBills] of Object.entries(billsByYear)) {
      const existingYearBills = await getYearBills(env, year, true);
      const newYearBills = [...existingYearBills, ...yearBills];
      await saveYearBills(env, year, newYearBills);
      added += yearBills.length;
    }
    
    return new Response(JSON.stringify({ 
      success: true, 
      added, 
      skipped: skipped.length,
      total: (await getAllBills(env, true)).length
    }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS() }
    });
  } catch (error) {
    return new Response("导入失败", { status: 500, headers: CORS_HEADERS() });
  }
}
