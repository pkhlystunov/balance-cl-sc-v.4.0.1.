// Изолированный модуль рендеринга гистограмм Chart.js
let myChart = null;

function updateAnalyticsWidgets(data) {
    let totalViolations = 0;
    const contractorMap = {};

    data.forEach(function(r) {
        totalViolations += r.vCount;
        if (r.vCount > 0) {
            if (!contractorMap[r.contractor]) contractorMap[r.contractor] = 0;
            contractorMap[r.contractor] += r.vCount;
        }
    });

    document.getElementById('w-checks').textContent = data.length;
    document.getElementById('w-violations').textContent = totalViolations;

    // Сбор массивов для графиков
    const labels = Object.keys(contractorMap);
    const counts = Object.values(contractorMap);

    renderChartCanvas(labels, counts);
}

function renderChartCanvas(labels, counts) {
    if (myChart) myChart.destroy(); // Сбрасываем старый холст во избежание наложения слоев

    const canvas = document.getElementById('violationsChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    myChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Количество зафиксированных нарушений',
                data: counts,
                backgroundColor: '#e74c3c',
                borderColor: '#c0392b',
                borderWidth: 1,
                barThickness: 35
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { 
                    beginAtZero: true, 
                    ticks: { stepSize: 1 } 
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}
